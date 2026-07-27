from io import BytesIO

from minio import Minio

from .config import settings


client = Minio(
    settings.minio_endpoint,
    access_key=settings.minio_access_key,
    secret_key=settings.minio_secret_key,
    secure=settings.minio_secure,
)


def get_bytes(bucket: str, object_key: str) -> bytes:
    response = client.get_object(bucket, object_key)
    try:
        return response.read()
    finally:
        response.close()
        response.release_conn()


def put_bytes(bucket: str, object_key: str, data: bytes, content_type: str) -> None:
    client.put_object(
        bucket,
        object_key,
        BytesIO(data),
        length=len(data),
        content_type=content_type,
    )
