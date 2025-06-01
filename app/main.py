from fastapi import FastAPI
from pydantic import BaseModel
from app.routers import users
from app.db import connection
import asyncio

app = FastAPI()
app.include_router(users.router)

@app.on_event("startup")
async def db_connect():
    await connection.initialize_connection(5,10)
@app.get("/")
def index():
    return "world"

