from fastapi import APIRouter, Response,Depends,HTTPException,Cookie
from fastapi.encoders import jsonable_encoder
from fastapi.responses import RedirectResponse
from jwt import decode
from pydantic import BaseModel
from db import connection
from os import getenv
import jwt
from datetime import datetime,timedelta,timezone
from typing import Annotated
from loguru import logger
from sys import exit
import secrets, hashlib

router = APIRouter()

JWT_SECRET_KEY = getenv("JWT_SECRET_KEY",None)
if JWT_SECRET_KEY is None:
    logger.critical("JWT_SECRET_KEY NOT FOUND")
    exit(1)

ALGO = "HS256"
ACCESS_TOKEN_EXPIRE_MINUTES = 600 
REFRESH_TOKEN_EXPIRE_MINUTES = 10080   # 7 days

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

def generate_refresh_token():
    raw = secrets.token_urlsafe(32)
    token_hash = hashlib.sha256(raw.encode()).hexdigest()
    created_at = datetime.now(timezone.utc)
    expires_at = created_at + timedelta(minutes=REFRESH_TOKEN_EXPIRE_MINUTES)
    return (raw, token_hash, created_at, expires_at)

def set_auth_cookies(response, access_jwt, access_expire, refresh_raw, refresh_expire):
    response.set_cookie(key="session",value=access_jwt,httponly=True,secure=True,expires=access_expire)
    response.set_cookie(key="refresh_token",value=refresh_raw,httponly=True,secure=True,expires=refresh_expire,path="/api/refresh")

def verify_jwt(session:Annotated[str|None, Cookie()] = None):
    try:
        cookie_val = decode(session,JWT_SECRET_KEY,algorithms=["HS256"])
    except Exception as e:
        logger.debug(f"jwt verification failed: {e}")
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
    logger.info(f"new user {user.username} just registered!")
    return {"message":"Successfully Registed!"}

@router.post("/login",tags=["users"])
async def login(user: Annotated[User, Depends(user_validation)],response: Response):
    role,user_id = await connection.check_credentials(user.username,user.password)
    data = {"user":user.username,"role":role,"user_id":user_id}
    access_jwt,access_expire = create_access_token(data)
    raw,token_hash,created_at,expires_at = generate_refresh_token()
    await connection.insert_refresh_token(token_hash=token_hash,user_id=user_id,expires_at=expires_at.isoformat(),created_at=created_at.isoformat())
    set_auth_cookies(response,access_jwt,access_expire,raw,expires_at)
    logger.info(f"{user.username} logged in!")
    return {"message":"Successfully Loggined!"}

@router.post("/logout",tags=["users"])
async def logout(session: Annotated[dict|None, Depends(verify_jwt)],response: Response):
    if not session:
        raise HTTPException(status_code=403,detail="Unauthorized")
    user_id = session["user_id"]
    await connection.revoke_refresh_token(user_id)
    response.delete_cookie(key="session")
    response.delete_cookie(key="refresh_token")
    return {"message":"success"}

@router.get("/me",tags=["users"])
async def current_user(session: Annotated[dict|None, Depends(verify_jwt)]):
    if not session:
        raise HTTPException(status_code=403,detail="Unauthorized")
    profile = await connection.get_user_profile(session["user_id"])
    return {"user_id":session["user_id"],"user":session["user"],**profile}

@router.post("/refresh",tags=["users"])
async def refresh_token(refresh_token: Annotated[str|None, Cookie()], response: Response):
    if not refresh_token:
        raise HTTPException(status_code=403,detail="Unauthorized")
    old_hash = hashlib.sha256(refresh_token.encode()).hexdigest()
    uid = await connection.get_user_id_with_refresh(token_hash=old_hash)
    _,username,_,role,_,_ = await connection.get_user_info(user_id=uid)
    access_jwt,access_expire = create_access_token({"user":username,"role":role,"user_id":uid})
    raw,new_hash,created_at,expires_at = generate_refresh_token()
    await connection.refresh_refresh_token(user_id=uid,old_token_hash=old_hash,new_refresh_token=new_hash,expires_at=expires_at.isoformat(),created_at=created_at.isoformat())
    set_auth_cookies(response,access_jwt,access_expire,raw,expires_at)


