// utils/auth-helper.js
const crypto = require('crypto');

function generateSecureHash(jobId, totalAmount, secretKey) {
  // Use job ID and total amount as unique identifiers
  const hashInput = `${jobId}:${totalAmount}`;
  
  const hmac = crypto.createHmac('sha256', secretKey);
  hmac.update(hashInput);
  
  return hmac.digest('hex').slice(0, 16);
}

function validateSecureHash(jobId, totalAmount, providedHash, secretKey) {
  const expectedHash = generateSecureHash(jobId, totalAmount, secretKey);
  
  return crypto.timingSafeEqual(
    Buffer.from(expectedHash), 
    Buffer.from(providedHash)
  );
}

module.exports = {
  generateSecureHash,
  validateSecureHash
};
