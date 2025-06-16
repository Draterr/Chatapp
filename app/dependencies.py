from datetime import datetime
import json 


#create error_object with all the detail then json_Response will just append those objects into an array and display it
class response_object:
    def __init__(self,status_code=None,title=None,detail=None):
        self.status_code = status_code
        self.title = title 
        self.detail = detail 
    def set_attribute(self,status_code:int,title:str,detail:str):
        self.status_code = status_code
        self.title = title 
        self.detail = detail 
    def to_dict(self)->dict:
        return {"status_code":str(self.status_code),"title":self.title,"details":self.detail}
        
class json_response:
    def create_status(self,status:str,list_obj:list[response_object]):
        response = {status:[]}
        for error in list_obj:
            error = error.to_dict()
            response[status].append(error)
        return json.dumps(response)
    def create_message_json(self,chat_id:int,message:str,sent_date:str):
        res = {}
        res.update({"chat_id":chat_id})
        res.update({"message":message})
        res.update({"sent_date":sent_date})
        res = json.dumps(res)
        return res


