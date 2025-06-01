from fastapi import APIRouter
from pydantic import BaseModel
import asyncio
from app.db import connection

router = APIRouter()

class User(BaseModel):
    username: str
    password: str

class Profile(BaseModel):
    display_name: str
    avatar_url: str | None

@router.post("/register_user",tags=["users"])
async def register(user: User):
    #everyone user is a user by default
    role = "user"
    query = f"INSERT INTO users(username,password,role,display_name) VALUES ('{user.username}','{user.password}','{role}','{user.username}')"
    return await connection.insert_query(query)

