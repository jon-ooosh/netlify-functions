// Test function for HireHop authentication
const axios = require('axios');

exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    // Get authentication details from query parameters or environment variables
    const token = event.queryStringParameters?.token || process.env.HIREHOP_API_TOKEN;
    const username = event.queryStringParameters?.username || process.env.HIREHOP_USERNAME;
    const password = event.queryStringParameters?.password || process.env.HIREHOP_PASSWORD;
    const jobId = event.queryStringParameters?.job || '13851';
    const authType = event.queryStringParameters?.type || 'token';
    
    console.log(`Testing HireHop API with auth type: ${authType}, job: ${jobId}`);
    
    let apiUrl = '';
    let response;
    
    // Try different authentication methods
    if (authType === 'token') {
      // Method 1: Direct token in URL
      if (!token) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ message: 'Token is required for token authentication' })
        };
      }
      
      apiUrl = `https://myhirehop.com/api/job_data.php?job=${jobId}&token=${encodeURIComponent(token)}`;
      console.log(`Making token-based request to: ${apiUrl.substring(0, 60)}...`);
      response = await axios.get(apiUrl);
    } 
    else if (authType === 'login') {
      // Method 2: Login first, then use cookies
      if (!username || !password) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ message: 'Username and password are required for login authentication' })
        };
      }
      
      // Create a cookie jar axios instance to maintain session
      const axiosInstance = axios.create();
      
      // Step 1: Login to get cookies
      console.log('Attempting to login to HireHop...');
      const loginResponse = await axiosInstance.post('https://myhirehop.com/login_ajax.php', {
        username: username,
        password: password,
        remember: true
      }, {
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded'
        }
      });
      
      console.log('Login response:', loginResponse.data);
      
      // Step 2: Make the API request with cookies
      apiUrl = `https://myhirehop.com/api/job_data.php?job=${jobId}`;
      console.log(`Making cookie-based request to: ${apiUrl}`);
      response = await axiosInstance.get(apiUrl);
    }
    else if (authType === 'api') {
      // Method 3: Try using API with username/password
      if (!username || !password) {
        return {
          statusCode: 400,
          headers,
          body: JSON.stringify({ message: 'Username and password are required for API authentication' })
        };
      }
      
      apiUrl = `https://myhirehop.com/api/job_data.php?job=${jobId}&username=${encodeURIComponent(username)}&password=${encodeURIComponent(password)}`;
      console.log(`Making username/password request to: ${apiUrl.substring(0, 60)}...`);
      response = await axios.get(apiUrl);
    }
    else if (authType === 'direct') {
      // Method 4: Try direct access to job.php
      apiUrl = `https://myhirehop.com/job.php?id=${jobId}`;
      console.log(`Making direct request to: ${apiUrl}`);
      response = await axios.get(apiUrl, {
        maxRedirects: 0,  // Don't follow redirects
        validateStatus: status => status < 400 || status === 302  // Accept 302 redirect as success
      });
    }
    
    console.log(`Got response with status ${response.status}`);
    
    // Return the response
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'API test successful',
        authType,
        status: response.status,
        data: response.data,
        headers: response.headers
      })
    };
  } catch (error) {
    console.log('Error:', error);
    
    // Create a detailed error response
    const errorResponse = {
      message: 'HireHop API test failed',
      error: error.message
    };
    
    // Add response details if available
    if (error.response) {
      errorResponse.status = error.response.status;
      errorResponse.statusText = error.response.statusText;
      
      // For HTML responses, include the raw text
      if (error.response.headers['content-type']?.includes('text/html')) {
        errorResponse.html = error.response.data.substring(0, 300) + '...'; // Truncate to avoid huge responses
      } else {
        errorResponse.data = error.response.data;
      }
      
      // Include headers to check for cookies or auth info
      errorResponse.responseHeaders = error.response.headers;
    }
    
    // Add request details
    if (error.config) {
      errorResponse.requestUrl = error.config.url.substring(0, 100) + '...'; // Truncate for security
      errorResponse.requestMethod = error.config.method;
    }
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify(errorResponse)
    };
  }
};
