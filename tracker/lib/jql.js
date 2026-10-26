export class JqlError extends Error {}

const keywords = new Set(['and', 'or', 'not', 'in', 'is', 'empty', 'null', 'order', 'by', 'asc', 'desc']);

function tokenize(source) {
  const tokens = [];
  let index = 0;
  while (index < source.length) {
    const char = source[index];
    if (/\s/.test(char)) { index += 1; continue; }
    if (char === '"' || char === "'") {
      let end = index + 1;
      let value = '';
      while (end < source.length && source[end] !== char) {
        if (source[end] === '\\' && end + 1 < source.length) end += 1;
        value += source[end];
        end += 1;
      }
      if (end >= source.length) throw new JqlError(`Unterminated string at position ${index}.`);
      tokens.push({ type: 'string', value });
      index = end + 1;
      continue;
    }
    const operator = ['!=', '!~', '>=', '<=', '=', '~', '>', '<', '(', ')', ','].find(op => source.startsWith(op, index));
    if (operator) {
      tokens.push({ type: 'op', value: operator });
      index += operator.length;
      continue;
    }
    const match = /^[^\s=!~<>(),"']+/.exec(source.slice(index));
    if (!match) throw new JqlError(`Unexpected character "${char}" at position ${index}.`);
    const word = match[0];
    const lower = word.toLowerCase();
    tokens.push(keywords.has(lower) ? { type: 'keyword', value: lower } : { type: 'word', value: word });
    index += word.length;
  }
  return tokens;
}

export function parseJql(source = '') {
  const tokens = tokenize(source);
  let position = 0;
  const peek = () => tokens[position];
  const next = () => tokens[position++];
  const isKeyword = (value, token = peek()) => token?.type === 'keyword' && token.value === value;
  const isOp = (value, token = peek()) => token?.type === 'op' && token.value === value;
  const expect = (predicate, message) => {
    const token = next();
    if (!token || !predicate(token)) throw new JqlError(message);
    return token;
  };

  function parseValue() {
    const token = next();
    if (!token) throw new JqlError('Expected a value.');
    if (token.type === 'string') return { kind: 'literal', value: token.value };
    if (token.type === 'keyword' && (token.value === 'empty' || token.value === 'null')) return { kind: 'empty' };
    if (token.type === 'word') {
      if (isOp('(')) {
        next();
        expect(t => t.type === 'op' && t.value === ')', `Function ${token.value}() takes no arguments.`);
        return { kind: 'function', name: token.value.toLowerCase() };
      }
      return { kind: 'literal', value: token.value };
    }
    throw new JqlError(`Unexpected "${token.value}" where a value was expected.`);
  }

  function parseList() {
    if (peek()?.type === 'word' && isOp('(', tokens[position + 1])) {
      const value = parseValue();
      return [value];
    }
    expect(t => t.type === 'op' && t.value === '(', 'Expected "(" or a function after IN.');
    const values = [parseValue()];
    while (isOp(',')) { next(); values.push(parseValue()); }
    expect(t => t.type === 'op' && t.value === ')', 'Expected ")" to close the IN list.');
    return values;
  }

  function parseClause() {
    if (isOp('(')) {
      next();
      const inner = parseOr();
      expect(t => t.type === 'op' && t.value === ')', 'Expected ")".');
      return inner;
    }
    if (isKeyword('not')) {
      next();
      return { type: 'not', clause: parseClause() };
    }
    const field = next();
    if (!field || (field.type !== 'word' && field.type !== 'string')) throw new JqlError('Expected a field name.');
    const name = field.value.toLowerCase();
    const token = peek();
    if (['=', '!=', '~', '!~', '<', '<=', '>', '>='].some(op => isOp(op))) {
      next();
      return { type: 'compare', field: name, operator: token.value, values: [parseValue()] };
    }
    if (isKeyword('in')) {
      next();
      return { type: 'compare', field: name, operator: 'in', values: parseList() };
    }
    if (isKeyword('not')) {
      next();
      expect(t => t.type === 'keyword' && t.value === 'in', 'Expected IN after NOT.');
      return { type: 'compare', field: name, operator: 'not in', values: parseList() };
    }
    if (isKeyword('is')) {
      next();
      const negated = isKeyword('not') ? (next(), true) : false;
      const value = parseValue();
      if (value.kind !== 'empty') throw new JqlError('IS only supports EMPTY or NULL.');
      return { type: 'compare', field: name, operator: negated ? 'is not' : 'is', values: [value] };
    }
    throw new JqlError(`Expected an operator after "${field.value}".`);
  }

  function parseAnd() {
    let left = parseClause();
    while (isKeyword('and')) { next(); left = { type: 'and', left, right: parseClause() }; }
    return left;
  }

  function parseOr() {
    let left = parseAnd();
    while (isKeyword('or')) { next(); left = { type: 'or', left, right: parseAnd() }; }
    return left;
  }

  let where = null;
  if (peek() && !isKeyword('order')) where = parseOr();
  const orderBy = [];
  if (isKeyword('order')) {
    next();
    expect(t => t.type === 'keyword' && t.value === 'by', 'Expected BY after ORDER.');
    do {
      if (isOp(',')) next();
      const field = expect(t => t.type === 'word', 'Expected a field after ORDER BY.');
      let direction = 'asc';
      if (isKeyword('asc') || isKeyword('desc')) direction = next().value;
      orderBy.push({ field: field.value.toLowerCase(), direction });
    } while (isOp(','));
  }
  if (peek()) throw new JqlError(`Unexpected "${peek().value}".`);
  return { where, orderBy };
}

function resolveValue(value, context) {
  if (value.kind === 'function') {
    if (value.name === 'currentuser') return context.currentUser ? [context.currentUser.toLowerCase()] : [];
    const fn = context.functions?.[value.name];
    if (fn) return fn().map(entry => String(entry).toLowerCase());
    throw new JqlError(`Unsupported function ${value.name}().`);
  }
  return [String(value.value).toLowerCase()];
}

function evaluate(node, issue, context) {
  if (!node) return true;
  if (node.type === 'and') return evaluate(node.left, issue, context) && evaluate(node.right, issue, context);
  if (node.type === 'or') return evaluate(node.left, issue, context) || evaluate(node.right, issue, context);
  if (node.type === 'not') return !evaluate(node.clause, issue, context);
  const actual = context.fieldValues(node.field, issue);
  if (actual === undefined) throw new JqlError(`Field "${node.field}" does not exist or cannot be searched.`);
  const values = actual.map(entry => String(entry).toLowerCase());
  switch (node.operator) {
    case 'is': return values.length === 0;
    case 'is not': return values.length > 0;
    case '~':
    case '!~': {
      const needle = resolveValue(node.values[0], context)[0];
      const found = values.some(entry => entry.includes(needle));
      return node.operator === '~' ? found : !found;
    }
    case '<': case '<=': case '>': case '>=': {
      const bound = resolveValue(node.values[0], context)[0];
      const numeric = /^-?\d+(\.\d+)?$/.test(bound);
      const order = entry => (numeric && /^-?\d+(\.\d+)?$/.test(entry) ? Number(entry) - Number(bound) : entry.localeCompare(bound));
      const test = { '<': d => d < 0, '<=': d => d <= 0, '>': d => d > 0, '>=': d => d >= 0 }[node.operator];
      return values.some(entry => test(order(entry)));
    }
    default: {
      const expected = node.values.flatMap(value => (value.kind === 'empty' ? [null] : resolveValue(value, context)));
      const matches = expected.some(entry => (entry === null ? values.length === 0 : values.includes(entry)));
      return node.operator === '=' || node.operator === 'in' ? matches : !matches;
    }
  }
}

export function runJql(source, issues, context) {
  const query = parseJql(source);
  const matched = issues.filter(issue => evaluate(query.where, issue, context));
  if (query.orderBy.length === 0) return matched;
  return matched.sort((a, b) => {
    for (const { field, direction } of query.orderBy) {
      const left = context.sortValue(field, a);
      const right = context.sortValue(field, b);
      if (left === undefined) throw new JqlError(`Field "${field}" cannot be used in ORDER BY.`);
      if (left < right) return direction === 'asc' ? -1 : 1;
      if (left > right) return direction === 'asc' ? 1 : -1;
    }
    return 0;
  });
}
