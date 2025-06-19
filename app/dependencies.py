def sort_by_time(res):
    new = sorted(res,key=lambda x:x.time_sent)
    return new
