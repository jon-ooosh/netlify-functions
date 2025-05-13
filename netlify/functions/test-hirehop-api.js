// test-hirehop-api.js - Simple test function to verify HireHop API endpoints
const fetch = require('node-fetch');

exports.handler = async (event, context) => {
  try {
    // Get query parameters
    const params = new URLSearchParams(event.queryStringParameters);
    const jobId = params.get('jobId');
    const endpoint = params.get('endpoint');
    
    if (!jobId) {
      return {
        statusCode: 400,
        body: JSON.stringify({ error: 'Job ID is required' })
      };
    }
    
    // Get environment variables
    const token = process.env.HIREHOP_API_TOKEN;
    const hirehopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    let url;
    
    // Determine which endpoint to test
    switch (endpoint) {
      case 'job_data':
        url = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${token}`;
        break;
      
      case 'job_margins':
        url = `https://${hirehopDomain}/php_functions/job_margins.php?job_id=${jobId}&token=${token}`;
        break;
      
      case 'items_list':
        url = `https://${hirehopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${token}`;
        break;
      
      case 'payment_receipts':
        url = `https://${hirehopDomain}/frames/payment_receipts_list.php?job=${jobId}&token=${token}`;
        break;
        
      case 'billing_list':
        url = `https://${hirehopDomain}/frames/billing_list.php?job=${jobId}&token=${token}`;
        break;
        
      case 'billing_grid':
        url = `https://${hirehopDomain}/frames/grids/billing_grid.php?job_id=${jobId}&token=${token}`;
        break;
      
      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ 
            error: 'Invalid endpoint parameter', 
            validOptions: ['job_data', 'job_margins', 'items_list', 'payment_receipts', 'billing_list', 'billing_grid'] 
          })
        };
    }
    
    console.log(`Testing HireHop endpoint: ${url}`);
    
    // Make the API request
    const response = await fetch(url);
    const contentType = response.headers.get('content-type');
    
    // Get response as text first
    const responseText = await response.text();
    
    // Try to parse as JSON if it looks like JSON
    let responseData;
    try {
      if (responseText.trim().startsWith('{') || responseText.trim().startsWith('[')) {
        responseData = JSON.parse(responseText);
      } else {
        responseData = responseText;
      }
    } catch (e) {
      // If parsing fails, return the raw text
      responseData = responseText;
    }
    
    return {
      statusCode: 200,
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        url,
        statusCode: response.status,
        contentType,
        responseSize: responseText.length,
        response: responseData,
        rawResponse: responseText.substring(0, 1000) // First 1000 chars for debugging
      })
    };
    
  } catch (error) {
    console.error('Error:', error);
    return {
      statusCode: 500,
      body: JSON.stringify({ error: 'Internal server error', details: error.message })
    };
  }
};
