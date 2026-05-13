from pydantic import BaseModel


class MixRequest(BaseModel):
    drink_id: str
