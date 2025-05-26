const crypto = require('crypto');

function generateSecureHash(jobId, totalAmount, secretKey) {
  // Create a simple, consistent hash using job ID and total amount
  const hashInput = `${jobId}:${totalAmount}`;
  
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(hashInput);
  
  // Return first 16 characters of the hash for brevity
  return hmac.digest('hex').slice(0, 16);
}

function validateSecureHash(jobId, totalAmount, providedHash, secretKey) {
  const expectedHash = generateSecureHash(jobId, totalAmount, secretKey);
  
  // Use timing-safe comparison to prevent timing attacks
  return crypto.timingSafeEqual(
    Buffer.from(expectedHash), 
    Buffer.from(providedHash)
  );
}

module.exports = {
  generateSecureHash,
  validateSecureHash
};
