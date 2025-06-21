import asyncio
import redis.asyncio as redis

r = redis.Redis(host='localhost',port=6379,decode_responses=True)

p = r.pubsub()
