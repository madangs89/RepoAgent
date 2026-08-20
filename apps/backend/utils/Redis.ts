import Redis from "ioredis";
export const redisClient: Redis = new Redis(process.env.REDIS_URL!);

