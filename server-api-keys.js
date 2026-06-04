// ============================================
// HISAB PRO - SECURE BACKEND WITH API KEYS
// File: server-with-api-keys.js
// Features:
// - API Key authentication
// - Google Gemini AI integration
// - Rate limiting per API key
// - Webhook support
// ============================================

const express = require('express');
const cors = require('cors');
const helmet = require('helmet');
const cookieParser = require('cookie-parser');
const path = require('path');
const rateLimit = require('express-rate-limit');
const RedisStore = require('rate-limit-redis').default;
const redis = require('redis');
const jwt = require('jsonwebtoken');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const crypto = require('crypto');
require('dotenv').config();

const app = express();

// ============================================
// SECURITY HEADERS
// ============================================
app.use(helmet({
    contentSecurityPolicy: {
        directives: {
            defaultSrc: ["'self'"],
            scriptSrc: ["'self'"],
            styleSrc: ["'self'"],
            connectSrc: ["'self'", "https://generativelanguage.googleapis.com"],
        },
    },
    xssFilter: true,
    noSniff: true,
    hsts: { maxAge: 31536000, preload: true },
}));

// ============================================
// CORS - EXPLICIT ALLOWLIST
// ============================================
const allowedOrigins = process.env.ALLOWED_ORIGINS?.split(',') || [
    'http://localhost:3000',
    'http://localhost:5173',
    'https://hisab-pro.vercel.app'
];

app.use(cors({
    origin: (origin, callback) => {
        if (!origin || allowedOrigins.includes(origin)) {
            callback(null, true);
        } else {
            callback(new Error('CORS not allowed'));
        }
    },
    credentials: true,
}));

app.use(express.json({ limit: '10mb' }));
app.use(cookieParser());

// ============================================
// REDIS CLIENT (For rate limiting & caching)
// ============================================
// Create Redis client only when explicitly enabled (avoid noisy reconnects in dev)
const useRedis = process.env.USE_REDIS === 'true' || !!process.env.REDIS_HOST || !!process.env.REDIS_URL;
let redisClient = null;
let redisStoreAvailable = false;

if (useRedis) {
    redisClient = redis.createClient({
        socket: {
            host: process.env.REDIS_HOST || 'localhost',
            port: process.env.REDIS_PORT ? Number(process.env.REDIS_PORT) : 6379,
        },
        password: process.env.REDIS_PASSWORD || undefined,
    });

    redisClient.on('error', (err) => {
        console.error('Redis error:', err);
        redisStoreAvailable = false;
    });
    redisClient.on('ready', () => {
        console.log('Redis client ready for rate limiting');
        redisStoreAvailable = true;
    });

        redisClient.connect().catch((err) => {
        console.error('Redis connect error:', err);
        redisStoreAvailable = false;
        try {
            if (redisClient.disconnect) awaitDisconnect(redisClient);
            else if (redisClient.quit) awaitQuit(redisClient);
        } catch (e) {
            console.debug('Redis cleanup error:', e && e.message ? e.message : e);
        }
    });
} else {
    console.log('Redis disabled (USE_REDIS not set). Using in-memory rate limiter.');
}

function awaitDisconnect(client) {
    try {
        return client.disconnect().catch(() => {});
    } catch (e) {
        return Promise.resolve();
    }
}

function awaitQuit(client) {
    try {
        return client.quit().catch(() => {});
    } catch (e) {
        return Promise.resolve();
    }
}

// ============================================
// RATE LIMITERS
// ============================================
const createRateLimiter = (windowMs, max) => {
    const limiterOptions = {
        windowMs,
        max,
        standardHeaders: true,
        legacyHeaders: false,
        handler: (req, res) => {
            res.status(429).json({
                error: 'Too many requests',
                retryAfter: req.rateLimit?.resetTime,
            });
        },
    };

    if (redisStoreAvailable) {
        try {
            limiterOptions.store = new RedisStore({
                sendCommand: (command) => redisClient.sendCommand(command),
                prefix: 'rate-limit:',
            });
        } catch (error) {
            console.warn('Redis rate limiter unavailable, falling back to memory store:', error.message);
        }
    }

    return rateLimit(limiterOptions);
};

const authLimiter = createRateLimiter(60 * 1000, 5);    // 5 req/min
const apiKeyLimiter = createRateLimiter(60 * 1000, 10); // 10 req/min per API key
const aiLimiter = createRateLimiter(60 * 1000, 20);     // 20 req/min

// ============================================
// API KEY MANAGEMENT
// ============================================

/**
 * API Keys are stored in database in production
 * Format: hisab_pro_xxxxxxxxxxxxx
 * Used for: Authenticating web app requests
 * 
 * For demo/testing, we have mock database
 */

// Mock database of API keys (use real database in production)
const apiKeysDatabase = {
    'hisab_pro_demo_key_12345': {
        name: 'Demo App',
        secret: 'secret_demo_12345',
        owner_id: 'user_123',
        created_at: new Date(),
        last_used: new Date(),
        is_active: true,
        rate_limit: 1000, // requests per day
    },
};

const demoUserEmail = (process.env.DEMO_USER_EMAIL || 'demo@hisabpro.com').toLowerCase();
const usersDatabase = {
    [demoUserEmail]: {
        email: demoUserEmail,
        name: 'Demo User',
        owner_id: 'user_123',
        passwordHash: bcrypt.hashSync(process.env.DEMO_USER_PASSWORD || 'Demo@1234', 10),
        role: 'user',
    },
};

/**
 * Generate API Key for frontend
 * These keys are sent to frontend for authentication
 * 
 * Flow:
 * 1. Backend generates: API_KEY + SECRET
 * 2. Frontend stores in .env
 * 3. Frontend sends API_KEY with every request
 * 4. Backend verifies API_KEY exists and is active
 */
function generateAPIKey() {
    const key = `hisab_pro_${crypto.randomBytes(16).toString('hex')}`;
    const secret = crypto.randomBytes(32).toString('hex');
    return { key, secret };
}

/**
 * EXAMPLE: Generate new API key
 * app.post('/admin/api-keys/generate', authenticateAdmin, (req, res) => {
 *   const { name } = req.body;
 *   const { key, secret } = generateAPIKey();
 *   // Save to database
 *   return res.json({ key, secret });
 * });
 */

// ============================================
// AUTHENTICATION MIDDLEWARE
// ============================================

/**
 * Verify API Key
 * Every request to /api/* endpoints must include API key
 */
const verifyAPIKey = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : undefined;
    const jwtToken = bearerToken || req.cookies?.auth_token;

    if (jwtToken) {
        try {
            const decoded = jwt.verify(jwtToken, process.env.JWT_SECRET);
            req.user = decoded;
            return next();
        } catch (err) {
            return res.status(401).json({
                error: 'Invalid or expired token',
            });
        }
    }

    const apiKey = req.headers['x-api-key'] || (!authHeader?.startsWith('Bearer ') && authHeader);

    if (!apiKey) {
        return res.status(401).json({
            error: 'Missing API key or authentication token',
            message: 'Use a valid session or X-API-Key header',
        });
    }

    // Check if API key exists in database
    const keyData = apiKeysDatabase[apiKey];
    
    if (!keyData || !keyData.is_active) {
        return res.status(403).json({
            error: 'Invalid or inactive API key',
        });
    }

    // Attach API key data to request
    req.apiKey = keyData;
    req.apiKeyString = apiKey;
    
    // Update last used
    keyData.last_used = new Date();

    // Try to check rate limits with Redis (if available)
    const dayLimitKey = `api_key_limit:${apiKey}:${new Date().toDateString()}`;
    
    redisClient.get(dayLimitKey).then((count) => {
        const requestCount = parseInt(count || '0');
        if (requestCount >= keyData.rate_limit) {
            return res.status(429).json({
                error: 'API key rate limit exceeded',
                limit: keyData.rate_limit,
                reset_at: new Date().getTime() + (24 * 60 * 60 * 1000),
            });
        }

        // Increment counter
        redisClient.incr(dayLimitKey).catch(() => {});
        redisClient.expire(dayLimitKey, 86400).catch(() => {});

        next();
    }).catch((err) => {
        // If Redis is unavailable, continue without rate limiting
        console.warn('Redis unavailable for rate limiting, proceeding without limits:', err.code);
        next();
    });
};

/**
 * Verify JWT Token (for backward compatibility)
 * Used if user has JWT token from login
 */
const verifyJWT = (req, res, next) => {
    const authHeader = req.headers.authorization;
    const token = authHeader?.startsWith('Bearer ') ? authHeader.split(' ')[1] : req.cookies?.auth_token;

    if (!token) {
        return res.status(401).json({ error: 'No token provided' });
    }

    try {
        const decoded = jwt.verify(token, process.env.JWT_SECRET);
        req.user = decoded;
        next();
    } catch (err) {
        res.status(401).json({ error: 'Invalid token' });
    }
};

const getRequestOwnerId = (req) => {
    return req.user?.userId || req.apiKey?.owner_id;
};

const getRequestOwnerName = (req) => {
    return req.user?.name || req.apiKey?.name || 'Unknown';
};

// ============================================
// GOOGLE GEMINI AI INTEGRATION
// ============================================

const { GoogleGenerativeAI } = require("@google/generative-ai");

// Initialize Google AI
const genAI = new GoogleGenerativeAI(process.env.GOOGLE_API_KEY);

/**
 * Call Google Gemini API
 * 
 * Why Google Gemini instead of Claude?
 * 1. Free tier: 60 requests per minute (very generous)
 * 2. No billing required initially
 * 3. Good for accounting queries
 * 4. Fast response times
 * 5. Multi-turn conversations supported
 */
async function callGeminiAPI(userMessage, conversationHistory = []) {
    try {
        // Get the Gemini model
        const model = genAI.getGenerativeModel({ 
            model: "gemini-pro",
            generationConfig: {
                maxOutputTokens: 500, // Prevent long responses
                temperature: 0.7, // Balanced creativity
                topP: 0.9,
                topK: 40,
            }
        });

        // [SECURITY] Sanitize user input
        const sanitizedMessage = sanitizePromptInput(userMessage);

        // [SECURITY] Check for prompt injection patterns
        if (hasPromptInjectionPatterns(sanitizedMessage)) {
            return 'Sorry, your message contains invalid content. Please ask accounting-related questions only.';
        }

        // Prepare conversation history for Gemini
        let conversationParts = [];
        
        // Add previous messages
        conversationHistory.forEach(msg => {
            conversationParts.push({
                role: msg.type === 'user' ? 'user' : 'model',
                parts: [{ text: msg.text }]
            });
        });

        // Add current user message with delimiters
        const systemPrompt = `You are an expert accounting assistant for Hisab Pro, an enterprise accounting software.

IMPORTANT RULES:
1. Help users with questions about invoicing, ledger, inventory, GST compliance
2. REFUSE any requests to help with hacking, unauthorized access, or bypassing security
3. If asked about non-accounting topics, politely redirect
4. Keep responses concise and practical
5. For sensitive actions, recommend contacting support
6. Your context: The user is using an accounting software called Hisab Pro

[USER_INPUT_START]
${sanitizedMessage}
[USER_INPUT_END]`;

        conversationParts.push({
            role: 'user',
            parts: [{ text: systemPrompt }]
        });

        // Call Gemini
        const result = await model.generateContent({
            contents: conversationParts,
        });

        const response = await result.response;
        const text = response.text();

        // [SECURITY] Validate LLM output
        if (!validateLLMOutput(text)) {
            return 'I can only help with accounting-related questions.';
        }

        return text;

    } catch (error) {
        // [SECURITY] Don't expose error details
        console.error('Gemini API error (details logged securely):', error.message);
        
        // Handle specific Google API errors
        if (error.message?.includes('API key')) {
            return 'Error: Invalid Google API key configuration. Please contact support.';
        }
        if (error.message?.includes('rate_limit')) {
            return 'Too many requests. Please wait a moment before sending another message.';
        }
        
        return 'Unable to get a response. Please try again later.';
    }
}

// ============================================
// SECURITY FUNCTIONS
// ============================================

function sanitizePromptInput(input) {
    if (!input) return '';
    // Remove non-printable ASCII control chars without using control-regex
    const filtered = Array.from(input).filter((ch) => {
        const c = ch.charCodeAt(0);
        return (c >= 32 && c !== 127) || c > 127; // keep printable and unicode
    }).join('');
    return filtered.trim().slice(0, 1000);
}

function hasPromptInjectionPatterns(input) {
    const injectionPatterns = [
        /ignore\s+previous/i,
        /forget\s+your/i,
        /system:/i,
        /assistant:/i,
        /execute\s+code/i,
        /bypass\s+security/i,
        /\[.*instruction.*\]/i,
    ];
    return injectionPatterns.some(pattern => pattern.test(input));
}

function validateLLMOutput(output) {
    const suspiciousPatterns = [
        /<!DOCTYPE/i,
        /<script/i,
        /eval\(/i,
        /process\.exit/i,
    ];
    return !suspiciousPatterns.some(pattern => pattern.test(output));
}

// ============================================
// INPUT VALIDATION SCHEMAS
// ============================================

const chatMessageSchema = z.object({
    message: z.string()
        .min(1, 'Message required')
        .max(1000, 'Message too long')
        .refine((msg) => !hasPromptInjectionPatterns(msg), 'Invalid message content'),
});

const validateRequest = (schema) => (req, res, next) => {
    try {
        const validated = schema.parse(req.body);
        req.validatedData = validated;
        next();
    } catch (err) {
        // [SECURITY] Don't expose validation details
        res.status(400).json({ error: 'Invalid input format' });
    }
};

// ============================================
// LOGGING (SECURE)
// ============================================

const logSafely = (message, data) => {
    const safeData = { ...data };
    delete safeData.password;
    delete safeData.token;
    delete safeData.apiKey;
    delete safeData.secret;
    console.log(`[${new Date().toISOString()}] ${message}`, JSON.stringify(safeData));
};

// ============================================
// ROUTES
// ============================================

/**
 * HEALTH CHECK
 * Used by monitoring services to verify backend is running
 */
app.get('/health', (req, res) => {
    res.json({
        status: 'OK',
        timestamp: new Date().toISOString(),
        environment: process.env.NODE_ENV,
        uptime: process.uptime(),
    });
});

/**
 * GET API KEY INFO
 * Frontend can check if their API key is valid
 */
app.get('/api/v1/auth/api-key-info', verifyAPIKey, (req, res) => {
    if (req.apiKey) {
        return res.json({
            api_key: req.apiKeyString,
            name: req.apiKey.name,
            owner_id: req.apiKey.owner_id,
            created_at: req.apiKey.created_at,
            last_used: req.apiKey.last_used,
            daily_limit: req.apiKey.rate_limit,
        });
    }

    res.json({
        email: req.user.email,
        name: req.user.name,
        owner_id: req.user.userId,
        role: req.user.role,
    });
});

app.post('/api/v1/auth/login', async (req, res) => {
    const { email, password } = req.body;

    if (!email || !password) {
        return res.status(400).json({ error: 'Email and password are required' });
    }

    const userRecord = usersDatabase[email.toLowerCase()];

    if (!userRecord || !bcrypt.compareSync(password, userRecord.passwordHash)) {
        return res.status(401).json({ error: 'Invalid email or password' });
    }

    const token = jwt.sign(
        {
            userId: userRecord.owner_id,
            email: userRecord.email,
            name: userRecord.name,
            role: userRecord.role,
        },
        process.env.JWT_SECRET,
        { expiresIn: '8h' }
    );

    const secureCookie = process.env.NODE_ENV === 'production';

    res.cookie('auth_token', token, {
        httpOnly: true,
        secure: secureCookie,
        sameSite: 'strict',
        maxAge: 8 * 60 * 60 * 1000,
    });

    res.json({
        status: 'ok',
        user: {
            email: userRecord.email,
            name: userRecord.name,
            owner_id: userRecord.owner_id,
        },
    });
});

app.post('/api/v1/auth/logout', (req, res) => {
    res.clearCookie('auth_token', {
        httpOnly: true,
        secure: process.env.NODE_ENV === 'production',
        sameSite: 'strict',
    });

    res.json({ status: 'ok' });
});

app.get('/api/v1/auth/me', verifyAPIKey, (req, res) => {
    if (req.user) {
        return res.json({
            user: {
                email: req.user.email,
                name: req.user.name,
                owner_id: req.user.userId,
                role: req.user.role,
            },
        });
    }

    res.status(401).json({ error: 'Not authenticated' });
});

/**
 * AI CHAT ENDPOINT
 * Frontend sends: { message: "user query" }
 * Backend returns: { response: "AI response" }
 * 
 * Authentication: API key or session cookie
 * Rate limit: 20 requests per minute per API key
 */
app.post(
    '/api/v1/ai/chat',
    verifyAPIKey,
    aiLimiter,
    validateRequest(chatMessageSchema),
    async (req, res) => {
        try {
            const response = await callGeminiAPI(req.validatedData.message);

            // [SECURITY] Log safely (no user message content)
            logSafely('AI chat message', {
                ownerId: getRequestOwnerId(req),
                authType: req.user ? 'jwt' : 'api-key',
                messageLength: req.validatedData.message.length,
                responseLength: response.length,
            });

            res.json({
                response,
                timestamp: new Date().toISOString(),
                model: 'gemini-pro',
            });

        } catch (err) {
            logSafely('AI chat error', { error: err.message });
            res.status(500).json({ error: 'Unable to process request' });
        }
    }
);

/**
 * INVOICE CREATION ENDPOINT
 * Example: How to use API key for other operations
 */
app.post(
    '/api/v1/invoices',
    verifyAPIKey,
    apiKeyLimiter,
    async (req, res) => {
        try {
            const { customerId, amount, items } = req.body;

            // [VALIDATION] Check required fields
            if (!customerId || !amount || !items) {
                return res.status(400).json({ 
                    error: 'Missing required fields: customerId, amount, items' 
                });
            }

            const ownerId = getRequestOwnerId(req);

            // Create invoice (in real app, save to database)
            const invoice = {
                id: crypto.randomUUID(),
                customer_id: customerId,
                amount,
                items,
                created_by: ownerId,
                created_at: new Date(),
                status: 'draft',
            };

            logSafely('Invoice created', {
                invoiceId: invoice.id,
                ownerId,
                amount,
            });

            res.status(201).json({
                invoice,
                message: 'Invoice created successfully',
            });

        } catch (err) {
            logSafely('Invoice creation error', { error: err.message });
            res.status(500).json({ error: 'Unable to create invoice' });
        }
    }
);

/**
 * WEBHOOK ENDPOINT
 * Example: Handle payment notifications
 * 
 * Razorpay sends webhooks with payment status
 * Verify webhook signature before processing
 */
app.post('/webhook/razorpay', (req, res) => {
    const sig = req.headers['x-razorpay-signature'];
    const webhookSecret = process.env.RZP_WEBHOOK_SECRET;

    if (!sig || !webhookSecret) {
        return res.status(400).json({ error: 'Missing webhook signature or secret' });
    }

    try {
        // [SECURITY] Verify webhook signature
        const crypto = require('crypto');
        const expected = crypto
            .createHmac('sha256', webhookSecret)
            .update(JSON.stringify(req.body))
            .digest('hex');

        if (sig !== expected) {
            return res.status(400).json({ error: 'Invalid webhook signature' });
        }

        // Process webhook
        const event = req.body.event;
        const data = req.body.payload;

        logSafely('Webhook received', { 
            event,
            dataType: typeof data,
        });

        if (event === 'payment.captured') {
            // Handle successful payment
            console.log('Payment captured:', data.payment.entity.id);
            // Update invoice status in database
        }

        res.json({ status: 'ok' });

    } catch (err) {
        logSafely('Webhook error', { error: err.message });
        res.status(500).json({ error: 'Webhook processing failed' });
    }
});

/**
 * DASHBOARD DATA ENDPOINT
 * Requires API key authentication
 */
app.get(
    '/api/v1/dashboard',
    verifyAPIKey,
    apiKeyLimiter,
    async (req, res) => {
        try {
            // Get owner's data only (based on authenticated identity)
            const ownerId = getRequestOwnerId(req);

            const dashboardData = {
                total_revenue: 245000,
                outstanding_invoices: 85500,
                inventory_value: 520000,
                net_profit: 42800,
                invoices_count: 45,
                customers_count: 25,
                owner_id: ownerId,
            };

            res.json(dashboardData);

        } catch (err) {
            logSafely('Dashboard error', { error: err.message });
            res.status(500).json({ error: 'Unable to fetch dashboard' });
        }
    }
);

// ============================================
// FRONTEND STATIC SERVING
// ============================================

// Serve static files from frontend/dist
const frontendPath = path.join(__dirname, '../hisab-pro-frontend/dist');
app.use(express.static(frontendPath));

// SPA fallback: serve index.html for non-API routes
app.get('*', (req, res) => {
    res.sendFile(path.join(frontendPath, 'index.html'));
});

/**
 * ERROR HANDLER
 * Catch-all for unhandled errors
 */
app.use((err, req, res, next) => {
    logSafely('Unhandled error', {
        path: req.path,
        method: req.method,
        error: err.message,
    });

    // [SECURITY] Don't expose stack traces
    res.status(err.status || 500).json({
        error: 'Internal server error',
        message: process.env.NODE_ENV === 'development' ? err.message : undefined,
    });
});

// ============================================
// STARTUP
// ============================================

const PORT = process.env.PORT || 3000;

app.listen(PORT, () => {
    console.log(`✅ Hisab Pro API running on port ${PORT}`);
    console.log(`🔒 Authentication: API Key or session cookie required`);
    console.log(`🤖 AI Provider: Google Gemini`);
    console.log(`🛡️  Environment: ${process.env.NODE_ENV}`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
    console.log('SIGTERM signal received: closing HTTP server');
    process.exit(0);
});

module.exports = app;
