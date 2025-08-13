from functools import cache
from pathlib import Path

from fastapi import HTTPException
import yaml

CONFIG_PATH = Path.home() / ".config" / "organized" / "config.yaml"


@cache
def get_config():
    """Loads the configuration from config.yaml."""
    if not CONFIG_PATH.exists():
        raise HTTPException(status_code=500, detail="Config file not found")
    return yaml.safe_load(CONFIG_PATH.read_text())
