// Simple test function for HireHop API
const axios = require('axios');

exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Content-Type': 'application/json'
  };

  try {
    // Get the token from environment variables
    const token = process.env.HIREHOP_API_TOKEN;
    
    // Get test parameters from query string
    const jobId = event.queryStringParameters?.job || '12345';
    const endpoint = event.queryStringParameters?.endpoint || 'j';
    
    if (!token) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ 
          message: 'HireHop API token is not configured',
          env_vars: Object.keys(process.env)
        })
      };
    }
    
    // Log what we're about to do
    console.log(`Testing HireHop API with endpoint: ${endpoint}, job: ${jobId}, token: ${token.substring(0, 10)}...`);
    
    // Construct the API URL exactly as shown in your Postman example
    let apiUrl = '';
    
    // First attempt - with the first successful endpoint
    if (endpoint === 'j') {
      apiUrl = `https://myhirehop.com/api/j?token=${encodeURIComponent(token)}`;
    } 
    // Second attempt - with the job_data.php endpoint and job ID
    else if (endpoint === 'job_data') {
      apiUrl = `https://myhirehop.com/api/job_data.php?job=${jobId}&token=${encodeURIComponent(token)}`;
    }
    
    console.log(`Making request to: ${apiUrl}`);
    
    // Make the request
    const response = await axios.get(apiUrl);
    
    console.log(`Got response with status ${response.status}`);
    
    // Return the response
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'API test successful',
        endpoint,
        status: response.status,
        data: response.data
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
      
      // For HTML responses (like 404 pages), include the raw text
      if (error.response.headers['content-type']?.includes('text/html')) {
        errorResponse.html = error.response.data.substring(0, 500) + '...'; // Truncate to avoid huge responses
      } else {
        errorResponse.data = error.response.data;
      }
    }
    
    // Add request details
    if (error.config) {
      errorResponse.requestUrl = error.config.url;
      errorResponse.requestMethod = error.config.method;
    }
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify(errorResponse)
    };
  }
};
