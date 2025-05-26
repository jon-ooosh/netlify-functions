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
    
    if (!token) {
      return {
        statusCode: 500,
        body: JSON.stringify({ error: 'HireHop API token not configured' })
      };
    }
    
    // URL encode the token properly
    const encodedToken = encodeURIComponent(token);
    
    let url;
    
    // Determine which endpoint to test
    switch (endpoint) {
      case 'job_data':
        url = `https://${hirehopDomain}/api/job_data.php?job=${jobId}&token=${encodedToken}`;
        break;
      
      case 'job_margins':
        url = `https://${hirehopDomain}/php_functions/job_margins.php?job_id=${jobId}&token=${encodedToken}`;
        break;
      
      case 'items_list':
        url = `https://${hirehopDomain}/frames/items_to_supply_list.php?job=${jobId}&token=${encodedToken}`;
        break;
      
      case 'payment_receipts':
        url = `https://${hirehopDomain}/frames/payment_receipts_list.php?job=${jobId}&token=${encodedToken}`;
        break;
        
      case 'billing_list':
        url = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
        break;
        
      case 'billing_grid':
        url = `https://${hirehopDomain}/frames/grids/billing_grid.php?job_id=${jobId}&token=${encodedToken}`;
        break;
      
      case 'billing_api':
        url = `https://${hirehopDomain}/php_functions/billing_list.php?main_id=${jobId}&type=1&token=${encodedToken}`;
        break;

        case 'get_job_details_v2':
  url = `https://${hirehopDomain}/.netlify/functions/get-job-details-v2?jobId=${jobId}`;
  break;
        case 'test_stripe_session':
  // This will test creating a deposit payment session
  const testData = {
    jobId: jobId,
    paymentType: 'deposit',
    successUrl: 'https://example.com/success',
    cancelUrl: 'https://example.com/cancel'
  };

        case 'test_stripe_session':
  try {
    const testData = {
      jobId: jobId,
      paymentType: 'deposit',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel'
    };
    
    const stripeResponse = await fetch(`https://ooosh-tours-payment-page.netlify.app/.netlify/functions/create-stripe-session`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(testData)
    });
    
    responseData = await stripeResponse.json();
    url = 'POST to create-stripe-session (deposit)';
  } catch (error) {
    responseData = { error: error.message };
    url = 'Error calling create-stripe-session';
  }
  break;
  
  const response = await fetch(`https://${hirehopDomain}/.netlify/functions/create-stripe-session`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(testData)
  });
  
  url = 'POST request to create-stripe-session';
  responseData = await response.json();
  break;
      
      default:
        return {
          statusCode: 400,
          body: JSON.stringify({ 
            error: 'Invalid endpoint parameter', 
            validOptions: ['job_data', 'job_margins', 'items_list', 'payment_receipts', 'billing_list', 'billing_grid', 'billing_api'] 
          })
        };
    }
    
    console.log(`Testing HireHop endpoint: ${url.substring(0, url.indexOf('token=') + 10)}...`);
    
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
        url: url.substring(0, url.indexOf('token=')) + 'token=[HIDDEN]', // Hide the token in response
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
