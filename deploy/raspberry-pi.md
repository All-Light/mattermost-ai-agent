# Running the agent on a Raspberry Pi at home

A Pi on your home network is a good fit for this agent, because **it never needs
an inbound connection**. The Mattermost adapter dials out to
`chat.aisociety.se` over REST v4 and a WebSocket, the MCP clients and Google
Calendar are outbound HTTPS, and the reminder sweep is a local timer. Nothing
on the internet has to reach the Pi.

That means: **no port forwarding, no dynamic DNS, no reverse proxy, no TLS
certificate.** The Pi can sit behind NAT on your home router exactly as it is.

The one exception is interactive card callbacks (`callbackUrl` on the adapter).
We do not use those; if that ever changes, the Pi would need a public URL and
everything above stops being true.

## Hardware and OS

| | Requirement | Why |
| --- | --- | --- |
| Model | Pi 4 or Pi 5, **4 GB+** | The Mastra build peaks well above 2 GB; the running agent is modest |
| OS | **64-bit** Raspberry Pi OS (Bookworm) or Ubuntu Server 24.04 LTS | Bun ships no 32-bit ARM build — a 32-bit OS cannot run the toolchain |
| Storage | **USB SSD**, not a microSD card | The agent writes to a SQLite WAL continuously; SD cards die of this |

Confirm the architecture before anything else:

```bash
uname -m     # must print aarch64. armv7l means you are on a 32-bit OS.
```

## You must build on the Pi

Do not copy `node_modules` or `.mastra/output` from your laptop. The dependency
tree contains **architecture-specific native binaries** — `@libsql/linux-x64-gnu`,
`@libsql/linux-x64-musl` and `@esbuild/linux-x64` on an x86 machine. On the Pi
those need to be the `arm64` builds, which only `bun install` running there will
fetch. A copied build fails at runtime, not at install time, which makes it an
annoying thing to debug.

## Install

```bash
# 1. Runtimes
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs git
curl -fsSL https://bun.sh/install | bash        # installs to ~/.bun/bin/bun

# 2. Service user and directories
sudo useradd --system --home /opt/mattermost-ai-agent --shell /usr/sbin/nologin uuais-agent
sudo mkdir -p /opt/mattermost-ai-agent /var/lib/uuais-agent /etc/uuais
sudo chown -R $USER:$USER /opt/mattermost-ai-agent

# 3. Code and build (10-20 minutes on a Pi 4 — this is normal)
git clone https://github.com/uuaisociety/mattermost-ai-agent.git /opt/mattermost-ai-agent
cd /opt/mattermost-ai-agent
bun install
cd apps/agent && bun run build
```

## Secrets

```bash
cp apps/agent/.env.example apps/agent/.env
# fill in MATTERMOST_BOT_TOKEN, OPENROUTER_API_KEY, CRM_MCP_TOKEN, GOOGLE_CALENDAR_ID, ...
chmod 600 apps/agent/.env
```

Copy the Google service-account key to a path **outside any home directory**,
so the systemd sandbox can still see it:

```bash
# The directory must be traversable by the service user, not just the file
# readable: root:root 750 leaves the agent with EACCES even when it owns the
# key inside, and the calendar tools then disable themselves at startup.
sudo chown root:uuais-agent /etc/uuais && sudo chmod 750 /etc/uuais
sudo install -o uuais-agent -g uuais-agent -m 600 \
  ~/uuais-bot-key.json /etc/uuais/uuais-bot-key.json
```

Then in `apps/agent/.env`:

```bash
GOOGLE_SERVICE_ACCOUNT_KEY_FILE=/etc/uuais/uuais-bot-key.json
```

> **Use the key file, not the inline private key.** systemd's `EnvironmentFile`
> parser is not dotenv — it cannot handle the multi-line, quoted PEM in
> `GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY`, and the failure is a confusing parse
> error rather than an obvious one.

Ownership and the state directory:

```bash
sudo chown -R uuais-agent:uuais-agent /opt/mattermost-ai-agent /var/lib/uuais-agent
```

## Service

```bash
sudo cp deploy/uuais-mattermost-agent.pi.service \
        /etc/systemd/system/uuais-mattermost-agent.service
sudo systemctl daemon-reload
sudo systemctl enable --now uuais-mattermost-agent
journalctl -u uuais-mattermost-agent -f
```

A healthy start logs `[reminders] scheduler started`, then
`[chat-sdk:mattermost] Mattermost websocket connected`.

## Pi-specific things that will bite you

**The clock.** A Pi has no battery-backed RTC, so it boots believing it is
whenever it last shut down. Google rejects the service account's signed JWT if
the clock is off, and you get an opaque `invalid_grant`. The unit waits on
`time-sync.target`; confirm sync is actually working:

```bash
timedatectl status        # expect: System clock synchronized: yes
```

**SD/SSD wear from logs.** Cap the journal so it cannot grind the disk:

```bash
sudo mkdir -p /etc/systemd/journald.conf.d
printf '[Journal]\nSystemMaxUse=50M\n' | sudo tee /etc/systemd/journald.conf.d/size.conf
sudo systemctl restart systemd-journald
```

**Power.** Use the official supply. Undervoltage causes filesystem corruption
that looks exactly like application bugs. Check with `vcgencmd get_throttled`
— anything other than `throttled=0x0` means power or heat problems.

**Unattended security updates:**

```bash
sudo apt-get install -y unattended-upgrades
sudo dpkg-reconfigure -plow unattended-upgrades
```

## The agent's sandboxed shell

`run_sandboxed_shell` executes throwaway scripts in a **rootless Podman**
container. Rootless matters: the agent's user is deliberately *not* in the
`docker` group and holds no `sudo` grant, so the sandbox cannot become a path
to root on the Pi.

```bash
sudo apt-get install -y podman uidmap slirp4netns
echo "uuais-agent:200000:65536" | sudo tee -a /etc/subuid
echo "uuais-agent:200000:65536" | sudo tee -a /etc/subgid
sudo loginctl enable-linger uuais-agent
sudo install -m 755 deploy/uuais-sandbox /usr/local/bin/uuais-sandbox
sudo -u uuais-agent sh -c 'cd /var/lib/uuais-agent && HOME=/var/lib/uuais-agent \
  podman --root=/var/lib/uuais-agent/containers/storage \
         --runroot=/var/lib/uuais-agent/containers/run \
         pull docker.io/library/python:3.12-alpine'
```

Verified properties of a sandbox run: no network, read-only root filesystem, no
host paths mounted, an empty environment (no tokens), `CapEff` of all zeroes,
container uids mapped to host 200000+, and a 30-second hard kill.

Two Pi-specific caveats:

- **Memory is capped with `ulimit -v`, not a cgroup.** Raspberry Pi OS boots
  with `cgroup_disable=memory`, so rootless Podman cannot set `memory.max` and
  fails outright if you pass `--memory`. Re-enabling the controller means
  appending `cgroup_enable=memory cgroup_memory=1` to
  `/boot/firmware/cmdline.txt` and rebooting — worth knowing that a malformed
  `cmdline.txt` leaves the Pi unbootable until you edit the card on another
  machine.
- **The kill must come from `--timeout`, not an outer `timeout`.** Killing the
  `podman` *client* does not stop the container: a runaway script survives and
  pins a core indefinitely, which on a Pi 5 means thermal throttling within
  minutes. The wrapper passes `--timeout` so `conmon` kills the container
  itself, with an outer `timeout` only as a backstop.

## Back up the database

`/var/lib/uuais-agent/mastra.db` holds agent memory, channel subscriptions and
the reminder queue. Losing it loses every pending reminder.

```bash
sudo crontab -e
# 03:00 daily, keep 7 days
0 3 * * * sqlite3 /var/lib/uuais-agent/mastra.db ".backup '/var/lib/uuais-agent/backup-$(date +\%u).db'"
```

## Docker instead

`deploy/Dockerfile` works on a Pi as-is — both base images have arm64 variants.
Build **on the Pi**, for the reason above:

```bash
docker build -t uuais-mattermost-agent -f deploy/Dockerfile .
docker run -d --name uuais-mattermost-agent --restart unless-stopped \
  --env-file apps/agent/.env \
  -v uuais-agent-data:/data \
  -v /etc/uuais/uuais-bot-key.json:/etc/uuais/uuais-bot-key.json:ro \
  uuais-mattermost-agent
```

Cross-building from an x86 laptop needs `docker buildx build --platform linux/arm64`.
Do not skip the platform flag.

## Upgrading

```bash
cd /opt/mattermost-ai-agent
sudo -u uuais-agent git pull
sudo -u uuais-agent bun install
cd apps/agent && sudo -u uuais-agent bun run build
sudo systemctl restart uuais-mattermost-agent
```

## Checklist

- [ ] `uname -m` prints `aarch64`
- [ ] `timedatectl` shows the clock synchronized
- [ ] `systemctl status uuais-mattermost-agent` is active
- [ ] Journal shows the WebSocket connected and the reminder scheduler started
- [ ] The bot answers a DM in Mattermost
- [ ] `ls -l /etc/uuais/uuais-bot-key.json` is `600`, owned by `uuais-agent`
- [ ] Router port forwarding: **none needed** — verify you did not add any
