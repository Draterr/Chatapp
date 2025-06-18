from fastapi import APIRouter, Response,Depends,HTTPException,Cookie
from jwt import decode
from pydantic import BaseModel
from app.db import connection
from os import getenv
import jwt
from datetime import datetime,timedelta,timezone
from typing import Annotated

router = APIRouter()

JWT_SECRET_KEY = getenv("JWT_SECRET_KEY")
ALGO = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 4320

class User(BaseModel):
    username: str
    password: str

class Profile(BaseModel):
    display_name: str
    avatar_url: str | None

class User_Response(BaseModel):
    status: int
    description: str
    time: datetime

def create_access_token(data:dict):
    expire = datetime.now(timezone.utc) + timedelta(minutes=ACCESS_TOKEN_EXPIRE_MINUTES)
    data.update({"exp":expire})
    encoded_jwt = jwt.encode(data,JWT_SECRET_KEY,algorithm=ALGO)
    cookie_expire_date = expire.strftime('%A, %d %b %Y %H:%M:%S GMT')
    return (encoded_jwt,cookie_expire_date)

async def verify_jwt(session:Annotated[str|None, Cookie()]):
    try:
        cookie_val = decode(session,JWT_SECRET_KEY,algorithms=["HS256"])
    except Exception as e:
        print(e)
        return None
    return cookie_val

async def user_validation(user:User):
    if len(user.username) < 1:
        raise HTTPException(status_code=400,detail="username can't be empty")
    if len(user.password) < 1:
        raise HTTPException(status_code=400,detail="password can't be empty")
    if len(user.username) > 255:
        raise HTTPException(status_code=400,detail="username has to be within 255 characters")
    return user


@router.post("/register",tags=["users"])
async def register(user: Annotated[User, Depends(user_validation)]):
    role = "user"
    await connection.insert_user(user.username,user.password,role,user.username)
    return {"message":"Successfully Registed!"}

@router.post("/login",tags=["users"])
async def login(user: Annotated[User, Depends(user_validation)],response: Response):
    role,user_id = await connection.check_credentials(user.username,user.password)
    data = {"user":user.username,"role":role,"user_id":user_id}
    jwt_token,cookie_expire_date = create_access_token(data)
    response.set_cookie(key="session",value=jwt_token,httponly=True,secure=True,expires=cookie_expire_date)
    return {"message":"Cookie Set!"}


