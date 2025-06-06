// functions/admin-auth.js - Admin authentication with session management
const crypto = require('crypto');

exports.handler = async (event, context) => {
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
    
    // Parse request body
    let data;
    try {
      data = JSON.parse(event.body);
    } catch (parseError) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Invalid JSON in request body' })
      };
    }
    
    const { password, jobId } = data;
    
    if (!password) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Password is required' })
      };
    }
    
    if (!jobId) {
      return {
        statusCode: 400,
        headers,
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    console.log(`🔐 Admin authentication attempt for job ${jobId}`);
    
    // Get admin password from environment
    const adminPassword = process.env.ADMIN_PASSWORD;
    
    if (!adminPassword) {
      console.error('❌ ADMIN_PASSWORD environment variable not configured');
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
      console.log(`❌ Invalid password attempt for job ${jobId} - length mismatch`);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid password' })
      };
    }
    
    const isValidPassword = crypto.timingSafeEqual(providedPassword, expectedPassword);
    
    if (!isValidPassword) {
      console.log(`❌ Invalid password attempt for job ${jobId}`);
      return {
        statusCode: 401,
        headers,
        body: JSON.stringify({ error: 'Invalid password' })
      };
    }
    
    console.log(`✅ Successful admin authentication for job ${jobId}`);
    
    // Generate session token
    const sessionToken = crypto.randomBytes(32).toString('hex');
    
    // Set expiry time (4 hours from now)
    const expiryTime = Date.now() + (4 * 60 * 60 * 1000); // 4 hours in milliseconds
    
    // In a production system, you'd store this in a database
    // For now, we'll include the expiry in the token itself and trust the client
    // The backend functions will validate the token format and expiry
    const tokenData = {
      token: sessionToken,
      expiry: expiryTime,
      jobId: jobId,
      createdAt: Date.now()
    };
    
    // Create a signed token to prevent tampering
    const tokenString = JSON.stringify(tokenData);
    const signature = crypto
      .createHmac('sha256', process.env.ADMIN_PASSWORD) // Use admin password as signing key
      .update(tokenString)
      .digest('hex');
    
    const signedToken = `${Buffer.from(tokenString).toString('base64')}.${signature}`;
    
    console.log(`🎫 Generated session token for admin, expires at ${new Date(expiryTime).toISOString()}`);
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        success: true,
        token: signedToken,
        expiry: expiryTime,
        expiresAt: new Date(expiryTime).toISOString(),
        message: 'Authentication successful'
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

module.exports = {
  validateSessionToken
};
