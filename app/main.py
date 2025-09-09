from dotenv import load_dotenv
load_dotenv() #load the environment variables in the main module so that all the child modules can have access to the env
from fastapi import FastAPI
from fastapi.responses import HTMLResponse
from fastapi.staticfiles import StaticFiles 
from routers import users,websocket,chats
from db import connection
from typing import Annotated
import uvicorn

app = FastAPI()
app.include_router(users.router)
app.include_router(websocket.wsroute)
app.include_router(chats.chats)
# app.mount("/static",StaticFiles(directory="static"),name="static")

@app.on_event("startup")
async def db_connect():
    await connection.initialize_connection(5,10)
@app.get("/")
def index():
    return HTMLResponse("""
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
        <form action="" onsubmit="sendMessage2(event)">
            <input type="text" id="messageText2" autocomplete="off"/>
            <button>Send</button>
        </form>
        <ul id='messages'>
        </ul>
        <script>
            var client_id = 2;
            document.querySelector("#ws-id").textContent = client_id;
            var ws = new WebSocket(`ws://127.0.0.1:8000/ws`);
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
            function sendMessage2(event) {
                var input = document.getElementById("messageText2")
                var chat_id = "2b9293a2-d50b-445a-a82f-777523bdb741";
                var json = {"client_id":client_id,"chat_id":chat_id,"message":input.value}
                ws.send(JSON.stringify(json))
                input.value = ''
                event.preventDefault()
            }
        </script>
    </body>
</html>
""")

@app.get("/client2")
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
        <form action="" onsubmit="sendMessage2(event)">
            <input type="text" id="messageText2" autocomplete="off"/>
            <button>Send</button>
        </form>
        <ul id='messages'>
        </ul>
        <script>
            var client_id = 3;
            document.querySelector("#ws-id").textContent = client_id;
            var ws = new WebSocket(`ws://127.0.0.1:8000/ws`);
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
            function sendMessage2(event) {
                var input = document.getElementById("messageText2")
                var chat_id = "2b9293a2-d50b-445a-a82f-777523bdb741";
                var json = {"client_id":client_id,"chat_id":chat_id,"message":input.value}
                ws.send(JSON.stringify(json))
                input.value = ''
                event.preventDefault()
            }
        </script>
    </body>
</html>
""")

if __name__ == "__main__":
    uvicorn.run(app,port=8000,host='0.0.0.0')
