from pydantic_settings import BaseSettings, SettingsConfigDict


class Settings(BaseSettings):
    minio_endpoint: str = "localhost:9000"
    minio_access_key: str = "propertytour"
    minio_secret_key: str = "propertytour_minio_password"
    minio_secure: bool = False
    minio_bucket_private: str = "propertytour-private"
    minio_bucket_public: str = "propertytour-public"
    vision_shared_secret: str = "change-me"
    log_level: str = "INFO"

    model_config = SettingsConfigDict(env_file=".env", case_sensitive=False)


settings = Settings()
