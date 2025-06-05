from fastapi import APIRouter, Cookie, Response
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
    return await connection.insert_query(user.username,user.password,role,user.username)

async def login(user: User,response: Response):
    valid = await connection.check_credentials(user.username,user.password)
    #assign cookie
    if valid:
       response.set_cookie(key="session",value="")
    elif valid == "Not Found":
        return "Couldn't find this username"
    elif not valid:
        return "incorrect username or password."


@router.get("/all_users",tags=["users"])
async def all():
    return await connection.get_all_users()

