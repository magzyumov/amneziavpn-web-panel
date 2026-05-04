---
name: Initial project scan
description: Amnezia Panel is a Node.js + React VPN management panel, NOT Spring Boot/Kotlin. Key protocols: AWG2, Xray VLESS Reality, WireGuard.
type: project
---

Amnezia Panel scanned on 2026-05-04. The project is a full-stack web panel for managing AmneziaVPN servers. Stack: Node.js/Express backend + React/Vite frontend, deployed via Docker Compose. Backend SSHes into VPS servers to manage Docker containers running VPN protocols. Three protocols supported: AmneziaWG 2.0 (obfuscated WireGuard), Xray VLESS Reality, and classic WireGuard. Protocol logic was reverse-engineered from the Amnezia Desktop Client binary. SQLite via sql.js for persistence. QR code generation via npm `qrcode` package. FLClash subscription system generates Clash YAML from VLESS URIs.

**Why:** The CLAUDE.md instructions assume Spring Boot/Kotlin, which this project is not. Any agent working on this project needs to know the actual stack upfront.

**How to apply:** Do not look for Spring Boot annotations, Gradle files, or Java/Kotlin source. All backend code is in `backend/src/` (JavaScript ES modules). All frontend code is in `frontend/src/` (React JSX).
