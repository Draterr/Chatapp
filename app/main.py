from dotenv import load_dotenv
print(load_dotenv()) #load the environment variables in the main module so that all the child modules can have access to the env
from fastapi import FastAPI
from routers import users,websocket,chats
from db import connection
import uvicorn

app = FastAPI()
app.include_router(users.router)
app.include_router(websocket.wsroute)
app.include_router(chats.chats)

@app.on_event("startup")
async def db_connect():
    await connection.initialize_connection(5,10)

