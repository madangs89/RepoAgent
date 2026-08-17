import Redis from "ioredis";

export const redisClient: Redis = new Redis("redis://localhost:6379");
