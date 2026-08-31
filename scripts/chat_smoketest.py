#!/usr/bin/env python3
"""
End-to-end smoke test for the chat pipeline — no browsers, no manual cookies.

It talks to the backend DIRECTLY (localhost:8000), sidestepping nginx and the
Secure-cookie problem: we read the session JWT out of the login response and
hand it to the WebSocket as a Cookie header ourselves.

Flow:
  1. register + login two users (idempotent — "already exists" is fine)
  2. decode each JWT to learn its user_id (needed to create a chat)
  3. create a shared chat containing both users
  4. open both WebSockets
  5. user A sends a message; assert A gets an `ack` and B receives the text

Run:  ./venv/bin/python scripts/chat_smoketest.py
"""
import asyncio
import base64
import json
import sys
import uuid

import httpx
import websockets

BASE = "http://127.0.0.1:8000"          # backend directly, not nginx
WS = "ws://127.0.0.1:8000/ws"
USERS = [("susan", "password"), ("dave", "password")]


def jwt_user_id(token: str) -> int:
    """Read the user_id claim without verifying the signature."""
    payload = token.split(".")[1]
    payload += "=" * (-len(payload) % 4)          # restore base64 padding
    return json.loads(base64.urlsafe_b64decode(payload))["user_id"]


async def login(client: httpx.AsyncClient, username: str, password: str) -> str:
    """Register (ignore-if-exists) then log in; return the session JWT."""
    await client.post("/register", json={"username": username, "password": password})
    r = await client.post("/login", json={"username": username, "password": password})
    r.raise_for_status()
    token = r.cookies.get("session")
    if not token:
        raise SystemExit(f"no session cookie for {username}: {r.text}")
    return token


async def recv_json(ws, timeout=3.0):
    raw = await asyncio.wait_for(ws.recv(), timeout)
    try:
        return json.loads(raw)
    except (json.JSONDecodeError, TypeError):
        return raw


async def main():
    async with httpx.AsyncClient(base_url=BASE, timeout=5.0) as client:
        tokens = {u: await login(client, u, p) for u, p in USERS}
        ids = {u: jwt_user_id(t) for u, t in tokens.items()}
        print("logged in:", ids)

        chat_id = str(uuid.uuid4())
        r = await client.post("/create_chat", json={
            "chat_id": chat_id,
            "chat_name": "smoketest",
            "chat_users": list(ids.values()),
            "is_dm": False,
        })
        r.raise_for_status()
        print("created chat", chat_id)

    a, b = (u for u, _ in USERS)
    async with websockets.connect(WS, additional_headers={"Cookie": f"session={tokens[a]}"}) as ws_a, \
               websockets.connect(WS, additional_headers={"Cookie": f"session={tokens[b]}"}) as ws_b:

        # B listens in the background while A sends.
        b_recv = asyncio.create_task(recv_json(ws_b))
        await asyncio.sleep(0.2)  # let both subscriptions settle

        text = "hello from A"
        await ws_a.send(json.dumps({"client_id": ids[a], "chat_id": chat_id, "message": text}))

        ack = await recv_json(ws_a)
        print(f"A got ack: {ack}")

        try:
            delivered = await b_recv
            print(f"B received: {delivered!r}")
            ok = text in json.dumps(delivered)
        except asyncio.TimeoutError:
            print("B received: <nothing within timeout>")
            ok = False

    print("\nRESULT:", "PASS ✅" if ok else "FAIL ❌ (B did not get the message)")
    sys.exit(0 if ok else 1)


if __name__ == "__main__":
    asyncio.run(main())
