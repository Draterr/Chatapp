#!/bin/sh

pip install --no-cache-dir -r /app/requirements.txt && pip install uvicorn
python3 main.py
