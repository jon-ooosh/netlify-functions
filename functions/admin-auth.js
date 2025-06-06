// functions/admin-auth.js - Enhanced admin authentication with rate limiting
const crypto = require('crypto');

// Simple in-memory rate limiting (resets on function restart)
const rateLimitStore = new Map();
const MAX_ATTEMPTS = 5;
const LOCKOUT_DURATION = 15 * 60 * 1000; // 15 minutes
const ATTEMPT_WINDOW = 5 * 60 * 1000; // 5 minutes

const handler = async (event, context) => {
  try {
    // Set CORS headers
    const headers = {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization',
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Content-Type': 'application/json'
    };

    // Handle preflight OPTIONS request
    if (event.httpMethod === 'OPTIONS') {
      return {
        statusCode: 200,
        headers,
        body: JSON.stringify({ message: 'Preflight call successful' })
      };
    }

    // Only allow POST requests
    if (event.httpMethod !== 'POST') {
      return {
        statusCode: 405,
        headers,
        body: JSON.stringify({ error: 'Method not allowed' })
      };
    }
    
    // Get client IP for rate limiting
    const clientIP = event.headers['x-forwarded-for']?.split(',')[0] || 
                     event.headers['x-real-ip'] || 
                     event.requestContext?.identity?.sourceIp || 
                     'unknown';
    
    console.log(`🔐 Admin authentication attempt from IP: ${clientIP}`);
    
    // Check rate limiting
    const rateLimitResult = checkRateLimit(clientIP);
    if (!rateLimitResult.allowed) {
      console.log(`🚫 Rate limit exceeded for IP ${clientIP}: ${rateLimitResult.reason}`);
      return {
        statusCode: 429,
        headers,
        body: JSON.stringify({ 
          error: 'Too many failed attempts', 
          details: rateLimitResult.reason,
          retryAfter: Math.ceil(rateLimitResult.retryAfter / 1000)
        })
      };
    }
    
    // Parse request body
    let data;
    try {
      data = JSON.parse(event.body);
    } catch (parseError) {
      recordFailedAttempt(clientIP, 'Invalid JSON');
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON in request body' })
      };
    }
    
    const { password, jobId } = data;
    
    if (!password) {
      recordFailedAttempt(clientIP, 'No password provided');
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Password is required' })
      };
    }
    
    if (!jobId) {
      recordFailedAttempt(clientIP, 'No job ID provided');
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    // Get admin password from environment
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (!adminPassword) {
      console.error('❌ ADMIN_PASSWORD environment variable not configured');
      recordFailedAttempt(clientIP, 'Server misconfiguration');
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ error: 'Admin authentication not configured' })
      };
    }
    
    // Validate password using timing-safe comparison
    const providedPassword = Buffer.from(password);
    const expectedPassword = Buffer.from(adminPassword);
    
    if (providedPassword.length !== expectedPassword.length) {
      console.log(`❌ Invalid password attempt for job ${jobId} from IP ${clientIP} - length mismatch`);
      recordFailedAttempt(clientIP, `Invalid password for job ${jobId}`);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid password' })
      };
    }
    
    const isValidPassword = crypto.timingSafeEqual(providedPassword, expectedPassword);
    
    if (!isValidPassword) {
      console.log(`❌ Invalid password attempt for job ${jobId} from IP ${clientIP}`);
      recordFailedAttempt(clientIP, `Invalid password for job ${jobId}`);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid password' })
      };
    }
    
    console.log(`✅ Successful admin authentication for job ${jobId} from IP ${clientIP}`);
    
    // Clear failed attempts on successful login
    clearFailedAttempts(clientIP);
    
    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry time (4 hours from now)
    const expiryTime = Date.now() + (4 * 60 * 60 * 1000); // 4 hours in milliseconds
    
    // Create token data
    const tokenData = {
      token: sessionToken,
      expiry: expiryTime,
      jobId: jobId,
      createdAt: Date.now(),
      clientIP: clientIP, // Track which IP created the token
      userAgent: event.headers['user-agent'] || 'unknown'
    };
    
    // Create a signed token to prevent tampering
    const tokenString = JSON.stringify(tokenData);
    const signature = crypto
      .createHmac('sha256', process.env.ADMIN_PASSWORD) // Use admin password as signing key
      .update(tokenString)
      .digest('hex');
    
    const signedToken = `${Buffer.from(tokenString).toString('base64')}.${signature}`;
    
    console.log(`🎫 Generated session token for admin from IP ${clientIP}, expires at ${new Date(expiryTime).toISOString()}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        token: signedToken,
        expiry: expiryTime,
        expiresAt: new Date(expiryTime).toISOString(),
        message: 'Authentication successful',
        sessionInfo: {
          createdAt: new Date().toISOString(),
          expiresAt: new Date(expiryTime).toISOString(),
          remainingAttempts: MAX_ATTEMPTS
        }
      })
    };
    
  } catch (error) {
    console.error('❌ Admin authentication error:', error);
    return {
      statusCode: 500,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({ error: 'Internal server error' })
    };
  }
};

// Rate limiting functions
function checkRateLimit(clientIP) {
  const now = Date.now();
  const clientData = rateLimitStore.get(clientIP);
  
  if (!clientData) {
    // First attempt from this IP
    return { allowed: true };
  }
  
  // Check if client is in lockout period
  if (clientData.lockedUntil && now < clientData.lockedUntil) {
    return { 
      allowed: false, 
      reason: `Account locked due to too many failed attempts`,
      retryAfter: clientData.lockedUntil - now
    };
  }
  
  // Clean up old attempts (outside the window)
  clientData.attempts = clientData.attempts.filter(attempt => 
    now - attempt.timestamp < ATTEMPT_WINDOW
  );
  
  // Check if too many attempts in the window
  if (clientData.attempts.length >= MAX_ATTEMPTS) {
    // Lock the account
    clientData.lockedUntil = now + LOCKOUT_DURATION;
    rateLimitStore.set(clientIP, clientData);
    
    console.log(`🚫 IP ${clientIP} locked out for ${LOCKOUT_DURATION / 1000 / 60} minutes due to ${clientData.attempts.length} failed attempts`);
    
    return { 
      allowed: false, 
      reason: `Too many failed attempts (${clientData.attempts.length}/${MAX_ATTEMPTS}). Account locked for ${LOCKOUT_DURATION / 1000 / 60} minutes.`,
      retryAfter: LOCKOUT_DURATION
    };
  }
  
  return { 
    allowed: true,
    remainingAttempts: MAX_ATTEMPTS - clientData.attempts.length
  };
}

function recordFailedAttempt(clientIP, reason) {
  const now = Date.now();
  const clientData = rateLimitStore.get(clientIP) || { attempts: [] };
  
  // Add this failed attempt
  clientData.attempts.push({
    timestamp: now,
    reason: reason
  });
  
  // Clean up old attempts
  clientData.attempts = clientData.attempts.filter(attempt => 
    now - attempt.timestamp < ATTEMPT_WINDOW
  );
  
  rateLimitStore.set(clientIP, clientData);
  
  console.log(`📝 Recorded failed attempt from IP ${clientIP}: ${reason} (${clientData.attempts.length}/${MAX_ATTEMPTS} in window)`);
}

function clearFailedAttempts(clientIP) {
  const clientData = rateLimitStore.get(clientIP);
  if (clientData) {
    clientData.attempts = [];
    clientData.lockedUntil = null;
    rateLimitStore.set(clientIP, clientData);
    console.log(`🧹 Cleared failed attempts for IP ${clientIP} after successful login`);
  }
}

// Helper function to validate session token (exported for use by other admin functions)
function validateSessionToken(authHeader, adminPassword) {
  try {
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return { valid: false, error: 'No valid authorization header' };
    }
    
    const signedToken = authHeader.substring(7); // Remove 'Bearer ' prefix
    const [tokenData64, signature] = signedToken.split('.');
    
    if (!tokenData64 || !signature) {
      return { valid: false, error: 'Invalid token format' };
    }
    
    // Verify signature
    const expectedSignature = crypto
      .createHmac('sha256', adminPassword)
      .update(Buffer.from(tokenData64, 'base64').toString())
      .digest('hex');
    
    if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
      return { valid: false, error: 'Invalid token signature' };
    }
    
    // Decode token data
    const tokenData = JSON.parse(Buffer.from(tokenData64, 'base64').toString());
    
    // Check expiry
    if (Date.now() > tokenData.expiry) {
      return { valid: false, error: 'Token expired' };
    }
    
    return { 
      valid: true, 
      tokenData,
      remainingTime: tokenData.expiry - Date.now()
    };
    
  } catch (error) {
    return { valid: false, error: 'Token validation error: ' + error.message };
  }
}

// Export both the handler and helper function
module.exports = {
  handler,
  validateSessionToken
};
