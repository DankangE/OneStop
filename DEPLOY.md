# AIRFRAME 아케이드·훈련 서버 배포

목표 서버: `192.168.0.7` · TCP 포트: `7175`

이 문서는 현재 저장소의 AIRFRAME 드론 게임을 배포합니다. Docker Engine과 Compose가 있는 서버에서 동일한 파일을 사용할 수 있습니다. 실행 이미지는 Node.js 24를 포함하므로 서버에 Node.js나 npm을 따로 설치할 필요가 없습니다.

## 서버에서 실행

1. 현재 프로젝트 폴더를 **192.168.0.7 서버 컴퓨터**에 복사합니다.
2. `compose.yaml`이 있는 폴더에서 터미널 또는 PowerShell을 엽니다.
3. 다음 명령을 실행합니다. 첫 실행에는 Docker 이미지 다운로드를 위한 인터넷 연결이 필요합니다.

```sh
docker compose up -d --build --wait
docker compose ps
```

`web` 상태가 `healthy`이면 서버에서는 http://127.0.0.1:7175, 같은 공유기 네트워크에서는 http://192.168.0.7:7175 로 접속합니다. 브라우저를 서버 컴퓨터에서 계속 열어둘 필요는 없습니다. 터미널을 닫아도 컨테이너는 실행됩니다.

기본값은 호스트 `0.0.0.0:7175` → 컨테이너 `7175`입니다. 별도 `.env` 파일은 필요하지 않습니다. 다른 수신 주소나 포트를 쓰려면 `.env.example`을 `.env`로 복사해 `BIND_ADDRESS`·`PORT`를 바꾼 뒤 위 명령을 다시 실행합니다. Node 프로세스의 `HOST`·`PORT`는 Compose 안에서 고정되며 `.env`의 `PORT`는 호스트 포트만 바꿉니다.

## 재부팅 후 자동 실행

Compose의 `restart: unless-stopped`는 프로세스가 종료되면 다시 실행하고, Docker가 다시 시작될 때 기존 컨테이너를 복구합니다. 관리자가 `stop` 또는 `down`으로 중지한 경우에는 자동으로 켜지지 않습니다. 다시 실행하려면 `docker compose up -d --wait`를 사용하세요. 상태 검사(`healthcheck`)는 이상 상태를 표시하며, `unhealthy` 표시만으로 자동 재시작하지는 않습니다. [Docker 재시작 정책](https://docs.docker.com/reference/compose-file/services/#restart)

**Linux 서버(Docker Engine + systemd):** 부팅 시 Docker도 켜지도록 설정합니다.

```sh
sudo systemctl enable --now docker
sudo systemctl enable containerd.service
```

배포 후에는 기존 컨테이너를 그대로 두면 됩니다. 앱 업데이트 때만 `docker compose up -d --build --wait`를 다시 실행하세요. [Docker 부팅 설정](https://docs.docker.com/engine/install/linux-postinstall/#configure-docker-to-start-on-boot-with-systemd)

**Windows/macOS의 Docker Desktop:** 설정 → General → `Start Docker Desktop when you sign in to your computer`를 켭니다. 이 방식은 **사용자 로그인 후** Docker가 시작됩니다. 로그인하지 않은 재부팅 상태에서도 계속 서비스해야 한다면 서버 OS에 맞는 서비스 등록이 추가로 필요합니다. [Docker Desktop 시작 설정](https://docs.docker.com/desktop/settings-and-maintenance/settings/#general)

서버 컴퓨터가 절전·최대 절전 상태가 되면 접속할 수 없습니다. 상시 운영 중에는 컴퓨터의 절전 설정도 꺼 두세요.

## 공유기와 방화벽

기존 포트포워딩의 내부 대상이 다음과 같은지 확인합니다.

| 항목 | 설정 |
| --- | --- |
| 내부 IP | `192.168.0.7` |
| 내부 포트 | `7175` |
| 프로토콜 | TCP |
| 외부 포트 | 공유기에서 지정한 포트, 예: `7175` |

서버 IP가 바뀌지 않도록 공유기 DHCP 예약 또는 고정 IP를 사용하세요. 서버 방화벽에는 TCP 7175 수신을 허용합니다. 공유기 포트포워딩과 서버 방화벽은 별도 설정입니다. 이 프로젝트의 파일을 실행하는 것만으로 공유기 설정이 변경되지는 않습니다.

- 내부 접속: `http://192.168.0.7:7175`
- 외부 접속: `http://공인IP:외부포트` 또는 `http://DDNS주소:외부포트`
- `192.168.0.7`은 내부 주소이므로 외부 인터넷에서는 그대로 사용할 수 없습니다.

휴대폰 Wi-Fi를 끄고 이동통신망에서 외부 주소를 열어 포트포워딩을 확인할 수 있습니다. 이 설정은 HTTP입니다. 도메인·HTTPS를 붙일 때는 앞단에 인증서를 갖춘 리버스 프록시를 추가합니다.

## 운영 명령

```sh
# 상태 / 실시간 로그
docker compose ps
docker compose logs --tail=100 -f web

# 수정한 파일로 업데이트
docker compose up -d --build --wait

# 프로세스 재시작
docker compose restart web

# 서비스 중지 및 컨테이너 제거
docker compose down
```

상태 확인 URL은 `http://192.168.0.7:7175/healthz`이며 정상 응답은 `{"status":"ok"}`입니다. 로그는 파일당 10MB, 최대 3개로 제한됩니다.

게임 HTML·CSS·JavaScript만 HTTP로 제공하고 `.env`, `.git`, 배포 설정, ZIP 등은 제공하지 않습니다. 게임 기록은 접속한 브라우저의 로컬 저장소에 저장됩니다. 기존 로컬 주소와 서버 주소의 기록은 별개이며, 서버 데이터베이스나 서버 저장 볼륨은 필요하지 않습니다.

## Docker 없이 실행 확인

Node.js 22 이상을 설치한 뒤 `npm start`를 실행하면 기본적으로 `0.0.0.0:7175`에서 열립니다. 의존성 패키지 설치는 필요하지 않습니다. 이 명령만으로는 상시 실행과 부팅 시 자동 실행이 구성되지 않으므로, Docker를 사용하지 않는 서버에는 해당 운영체제의 서비스 등록이 필요합니다.
