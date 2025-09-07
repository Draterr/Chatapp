import redis.asyncio as redis

class Pubsub:
    def __init__(self):
        self.r = redis.Redis(host='localhost',port=6379,decode_responses=True)
        self.pubsub = self.r.pubsub()

    async def subscribe(self,chat_id:str):
        await self.pubsub.subscribe(chat_id)

    async def publish_message(self,chat_id:str,message:str):
        try:
            await self.r.publish(chat_id,message)
        except Exception as e:
            print(e)
            return 0

    #getter function for pubsub
    @property
    def get_pubsub(self):
        return self.pubsub
