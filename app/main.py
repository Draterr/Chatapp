from dotenv import load_dotenv
load_dotenv() #load the environment variables in the main module so that all the child modules can have access to the env
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from pydantic import BaseModel
from app.routers import users,websocket,chats
from app.db import connection
import asyncio
import logging

app = FastAPI()
app.include_router(users.router)
app.include_router(websocket.wsroute)
app.include_router(chats.chats)

@app.on_event("startup")
async def db_connect():
    await connection.initialize_connection(5,10)
@app.get("/")
def index():
    return  HTMLResponse("""
<!DOCTYPE html>
<html>
    <head>
        <title>Chat</title>
    </head>
    <body>
        <h1>WebSocket Chat</h1>
        <h2>Your ID: <span id="ws-id"></span></h2>
        <form action="" onsubmit="sendMessage(event)">
            <input type="text" id="messageText" autocomplete="off"/>
            <button>Send</button>
        </form>
        <ul id='messages'>
        </ul>
        <script>
            var client_id = 2;
            document.querySelector("#ws-id").textContent = client_id;
            var ws = new WebSocket(`ws://localhost:8000/ws/${client_id}`);
            ws.onmessage = function(event) {
                var messages = document.getElementById('messages')
                var message = document.createElement('li')
                var content = document.createTextNode(event.data)
                message.appendChild(content)
                messages.appendChild(message)
            };
            function sendMessage(event) {
                var input = document.getElementById("messageText")
                var chat_id = "d1bcd22b-81fb-4094-8412-ff28a532c93a";
                var json = {"client_id":client_id,"chat_id":chat_id,"message":input.value}
                ws.send(JSON.stringify(json))
                input.value = ''
                event.preventDefault()
            }
        </script>
    </body>
</html>
""")

