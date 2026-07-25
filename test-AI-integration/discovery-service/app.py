"""FastAPI Discovery Service — Crawl4AI-based page analysis."""

from __future__ import annotations

import logging
from contextlib import asynccontextmanager

from fastapi import FastAPI, HTTPException
from fastapi.middleware.cors import CORSMiddleware

from crawler import crawl
from schemas import CrawlRequest, CrawlResponse

logging.basicConfig(level=logging.INFO, format="%(asctime)s %(levelname)s %(message)s")
logger = logging.getLogger(__name__)


@asynccontextmanager
async def lifespan(app: FastAPI):
    logger.info("Discovery service starting up")
    yield
    logger.info("Discovery service shutting down")


app = FastAPI(
    title="AI Test Platform — Discovery Service",
    description="DOM-based page discovery using Crawl4AI",
    version="1.0.0",
    lifespan=lifespan,
)

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)


@app.get("/health")
async def health():
    return {"status": "ok"}


@app.post("/crawl", response_model=CrawlResponse)
async def discover(req: CrawlRequest):
    """Crawl a URL and return structured DOM information."""
    logger.info(f"Crawling: {req.url}")
    try:
        result = await crawl(req.url, wait_after_load=req.wait_after_load)
        logger.info(
            f"Crawled {req.url}: {len(result.forms)} forms, "
            f"{len(result.links)} links, {len(result.buttons)} buttons, "
            f"{len(result.navigation)} nav items, "
            f"needs_vision={result.needs_vision}, "
            f"time={result.crawl_time_ms}ms"
        )
        return result
    except Exception as e:
        logger.error(f"Crawl failed for {req.url}: {e}")
        raise HTTPException(status_code=500, detail=str(e))


if __name__ == "__main__":
    import uvicorn

    uvicorn.run(app, host="0.0.0.0", port=8000)
