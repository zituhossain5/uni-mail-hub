"""Concise FastAPI pattern. Keep the SDK in the server lifespan."""

from contextlib import asynccontextmanager
from uuid import UUID

from fastapi import FastAPI, HTTPException, Request
from pydantic import BaseModel, EmailStr
from uni_mail import AsyncUniMail, UniMailError


class ContactInput(BaseModel):
    # Persist this ID with the submission; a retry must send the same ID.
    submission_id: UUID
    name: str
    email: EmailStr
    message: str


@asynccontextmanager
async def lifespan(app: FastAPI):
    async with AsyncUniMail.from_env() as mail:
        app.state.uni_mail = mail
        yield


app = FastAPI(lifespan=lifespan)


@app.post("/contact", status_code=202)
async def contact(data: ContactInput, request: Request):
    try:
        sent = await request.app.state.uni_mail.send(
            to="sales@bunevia.com", reply_to=str(data.email),
            subject=f"New enquiry from {data.name}", text=data.message,
            idempotency_key=f"contact:{data.submission_id}",
        )
    except UniMailError as exc:
        raise HTTPException(status_code=503, detail=f"Mail service: {exc.code}") from None
    return {"message_id": sent.id, "status": sent.status}

