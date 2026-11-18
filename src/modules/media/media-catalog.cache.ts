import { Injectable } from "@nestjs/common";
import { RedisCacheProvider } from "@/shared/infrastructure/cache/redis-cache.provider.js";
import type { CatalogMovie } from "./media.types.js";

/** Holds the response of GET /media/catalog (AVAILABLE, CMAF-ready movies). */
const CATALOG_KEY = "media:catalog:available";
/**
 * Upper bound on staleness if an invalidation is lost (Redis down during the
 * write) or races a concurrent refill.
 */
const CATALOG_TTL_SECONDS = 60;

/** Cached catalog; every write to `movies` must call `invalidate()`. */
@Injectable()
export class MediaCatalogCache {
    constructor(private readonly cache: RedisCacheProvider) {}

    async get(): Promise<CatalogMovie[] | null> {
        return await this.cache.getJson<CatalogMovie[]>(CATALOG_KEY);
    }

    async set(catalog: CatalogMovie[]): Promise<void> {
        await this.cache.setJson(CATALOG_KEY, catalog, CATALOG_TTL_SECONDS);
    }

    async invalidate(): Promise<void> {
        await this.cache.del(CATALOG_KEY);
    }
}
