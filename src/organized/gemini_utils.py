from functools import cache

import google.genai as genai
from fastapi import HTTPException

from .config import get_config


@cache
def get_genai_client():
    config = get_config()
    api_key = config.get("gemini", {}).get("api_key")
    if not api_key:
        raise HTTPException(status_code=500, detail="Gemini API key not found")

    return genai.Client(api_key=api_key)
