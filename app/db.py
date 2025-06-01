import asyncio 
import aiomysql
from typing import *
from dotenv import load_dotenv
import os

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
    async def fetchall_query(self,query):
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(query)
                res = await cur.fetchall()
                return res

    async def insert_query(self,query):
        async with self.pool.acquire() as conn:
            async with conn.cursor() as cur:
                await cur.execute(query)
                await conn.commit()
    

connection = Database(user,password,database,host)
