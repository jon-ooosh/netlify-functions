// Netlify Function to get billing data from HireHop
const axios = require('axios');

exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*',
    'Access-Control-Allow-Headers': 'Content-Type',
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

  // Check if this is a GET request
  if (event.httpMethod !== 'GET') {
    return {
      statusCode: 405,
      headers,
      body: JSON.stringify({ message: 'Method not allowed' })
    };
  }

  // Get job ID from query parameters
  const jobId = event.queryStringParameters?.job;
  
  if (!jobId) {
    return {
      statusCode: 400,
      headers,
      body: JSON.stringify({ message: 'Job ID is required' })
    };
  }

  try {
    // HireHop API credentials from environment variables
    const hireHopToken = process.env.HIREHOP_API_TOKEN;
    const hireHopDomain = process.env.HIREHOP_DOMAIN || 'hirehop.net';
    
    if (!hireHopToken) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ message: 'HireHop API token is not configured' })
      };
    }
    
    console.log(`Fetching billing data for job ${jobId}`);
    
    // Based on the screenshot, the billing tab might be accessible at a specific URL
    // Let's try a variety of possible endpoints that could contain billing information
    
    // Define all the endpoints we want to try
    const endpoints = [
      // Direct billing tab content
      `https://${hireHopDomain}/frames/tabs/billing.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Billing list endpoint (might contain billing items)
      `https://${hireHopDomain}/frames/billing_list.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Direct HTML request to the billing page (might be HTML with table data)
      `https://${hireHopDomain}/frames/billing.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Try accessing the billing grid data directly
      `https://${hireHopDomain}/frames/grids/billing_grid.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Try a direct API call for billing data if it exists
      `https://${hireHopDomain}/api/job_billing.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`,
      
      // Financial summary that might include payment info
      `https://${hireHopDomain}/php_functions/job_summary.php?job_id=${jobId}&token=${encodeURIComponent(hireHopToken)}`
    ];
    
    // Try each endpoint and collect all results
    const results = {};
    
    for (let i = 0; i < endpoints.length; i++) {
      const endpointUrl = endpoints[i];
      const endpointName = `endpoint${i+1}`;
      
      try {
        console.log(`Trying ${endpointName}: ${endpointUrl.substring(0, endpointUrl.indexOf('token'))}`);
        const response = await axios.get(endpointUrl);
        results[endpointName] = {
          status: response.status,
          data: response.data,
          contentType: response.headers['content-type']
        };
      } catch (error) {
        results[endpointName] = {
          error: error.message,
          status: error.response?.status || 'No response'
        };
      }
    }
    
    // Try a more direct approach - the billing grid might be accessed via a POST request
    try {
      const billingGridUrl = `https://${hireHopDomain}/frames/grids/billing_grid.php`;
      const billingGridResponse = await axios.post(billingGridUrl, 
        `job=${jobId}&token=${encodeURIComponent(hireHopToken)}`, 
        {
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded'
          }
        }
      );
      
      results.billingGridPost = {
        status: billingGridResponse.status,
        data: billingGridResponse.data,
        contentType: billingGridResponse.headers['content-type']
      };
    } catch (error) {
      results.billingGridPost = {
        error: error.message,
        status: error.response?.status || 'No response'
      };
    }
    
    // Also let's fetch the basic job data to ensure we have a reference
    try {
      const jobDataUrl = `https://${hireHopDomain}/api/job_data.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
      const jobDataResponse = await axios.get(jobDataUrl);
      results.jobData = jobDataResponse.data;
    } catch (error) {
      results.jobData = { error: error.message };
    }
    
    // And the financial data for reference
    try {
      const financialUrl = `https://${hireHopDomain}/php_functions/job_margins.php?job_id=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
      const financialResponse = await axios.get(financialUrl);
      results.financialData = financialResponse.data;
    } catch (error) {
      results.financialData = { error: error.message };
    }
    
    // Return all the results - one of these should contain the payment data
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Billing data exploration',
        jobId,
        results: results
      })
    };
    
  } catch (error) {
    console.log('Error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        message: 'Error exploring billing data', 
        error: error.message
      })
    };
  }
};
