#!/bin/sh

pip install --no-cache-dir -r /app/requirements.txt && pip install uvicorn
exec uvicorn app.main:app --host 0.0.0.0 --port 8000 --reload
