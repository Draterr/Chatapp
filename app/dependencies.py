import json # import typing


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
    def create_message(self,status:str,list_obj:list[response_object]):
        response = {status:[]}
        for error in list_obj:
            error = error.to_dict()
            response[status].append(error)
        return json.dumps(response)

# if __name__ == "__main__":
    # test = json_response()
    # a = [response_object(422,"test","lol")]
