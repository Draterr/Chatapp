import asyncio 
import aiomysql
from typing import *
from dotenv import load_dotenv
import os
from passlib.hash import bcrypt

load_dotenv()
user = os.getenv("DB_USER")
password = os.getenv("DB_PASSWORD")
host = os.getenv("DB_HOST")
database = os.getenv("DB_DATABASE")

class Database:
    def __init__(self,user: str|None,password:str|None,database:str|None,host:str|None):
        self.user = user
        self.password = password
        self.database = database 
        self.host = host

    async def initialize_connection(self,min_pool_size:int ,max_pool_size:int):
        self.pool = await aiomysql.create_pool(host=self.host,
                                               user=self.user,
                                               password=self.password,
                                               port=3307,
                                               db=self.database,
                                               minsize=min_pool_size,
                                               maxsize=max_pool_size,
                                               )
    async def get_all_users(self):
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute("SELECT * FROM users")
                res = await cur.fetchall()
                return res

    async def check_credentials(self,username:str,password:str):
        prepared_query = "SELECT password FROM users WHERE username= %s"
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(prepared_query,username)
                stored_password = await cur.fetchone()[2] #fetchone returns tuple 2nd element is password hash
                if stored_password:
                    return bcrypt.verify(password,stored_password)
                return "Not Found"

    async def insert_user(self,username:str,password:str,role:str,display_name:str):
        prepared_query = "INSERT INTO users(username,password,role,display_name) VALUES(%s,%s,%s,%s)"
        hashed_password = bcrypt.using(rounds=12).hash(password)
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(prepared_query,(username,hashed_password,role,display_name))
                await conn.commit()
    

connection = Database(user,password,database,host)
