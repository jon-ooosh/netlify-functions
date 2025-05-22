// Netlify Function to scrape HireHop billing page
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
    
    console.log(`Attempting to scrape billing page for job ${jobId}`);
    
    // First, we need to log in to HireHop to get cookies
    // Create an axios instance that will maintain cookies between requests
    const axiosInstance = axios.create({
      maxRedirects: 5,
      withCredentials: true
    });
    
    // Try multiple approaches to access the billing data
    const attempts = [];
    
    // Attempt 1: Try accessing the billing page directly via the job.php page
    try {
      const jobUrl = `https://${hireHopDomain}/job.php?id=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
      console.log(`Attempt 1: Accessing job page directly at ${jobUrl.substring(0, jobUrl.indexOf('token'))}`);
      
      const jobResponse = await axiosInstance.get(jobUrl);
      attempts.push({
        name: 'Job Page Direct',
        status: jobResponse.status,
        contentType: jobResponse.headers['content-type'],
        contentLength: jobResponse.data?.length || 0,
        isHtml: typeof jobResponse.data === 'string' && jobResponse.data.includes('<!DOCTYPE html')
      });
      
      // Save the cookies from this request
      const cookies = jobResponse.headers['set-cookie'];
      
      // If we got cookies, try accessing the billing tab directly
      if (cookies) {
        const billingUrl = `https://${hireHopDomain}/job.php?id=${jobId}&tab=billing&token=${encodeURIComponent(hireHopToken)}`;
        console.log(`Attempt 1b: Accessing billing tab directly with cookies`);
        
        const billingResponse = await axiosInstance.get(billingUrl, {
          headers: {
            Cookie: cookies.join('; ')
          }
        });
        
        attempts.push({
          name: 'Billing Tab Direct with Cookies',
          status: billingResponse.status,
          contentType: billingResponse.headers['content-type'],
          contentLength: billingResponse.data?.length || 0,
          isHtml: typeof billingResponse.data === 'string' && billingResponse.data.includes('<!DOCTYPE html')
        });
      }
    } catch (error) {
      attempts.push({
        name: 'Job Page Direct',
        error: error.message,
        status: error.response?.status
      });
    }
    
    // Attempt 2: Try a direct request to the billing table data
    try {
      // This URL is based on how the billing page might load its data
      const billingDataUrl = `https://${hireHopDomain}/php_functions/get_billing_data.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
      console.log(`Attempt 2: Direct request to billing data at ${billingDataUrl.substring(0, billingDataUrl.indexOf('token'))}`);
      
      const billingDataResponse = await axiosInstance.get(billingDataUrl);
      attempts.push({
        name: 'Billing Data Direct',
        status: billingDataResponse.status,
        contentType: billingDataResponse.headers['content-type'],
        response: billingDataResponse.data
      });
    } catch (error) {
      attempts.push({
        name: 'Billing Data Direct',
        error: error.message,
        status: error.response?.status
      });
    }
    
    // Attempt 3: Try getting all transactions for the job
    try {
      // This might provide all financial transactions
      const transactionsUrl = `https://${hireHopDomain}/api/job_transactions.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
      console.log(`Attempt 3: Transactions API at ${transactionsUrl.substring(0, transactionsUrl.indexOf('token'))}`);
      
      const transactionsResponse = await axiosInstance.get(transactionsUrl);
      attempts.push({
        name: 'Transactions API',
        status: transactionsResponse.status,
        contentType: transactionsResponse.headers['content-type'],
        response: transactionsResponse.data
      });
    } catch (error) {
      attempts.push({
        name: 'Transactions API',
        error: error.message,
        status: error.response?.status
      });
    }
    
    // Attempt 4: Try a dedicated financial transactions API if it exists
    try {
      const financialTransactionsUrl = `https://${hireHopDomain}/api/financial_transactions.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
      console.log(`Attempt 4: Financial transactions at ${financialTransactionsUrl.substring(0, financialTransactionsUrl.indexOf('token'))}`);
      
      const financialTransactionsResponse = await axiosInstance.get(financialTransactionsUrl);
      attempts.push({
        name: 'Financial Transactions API',
        status: financialTransactionsResponse.status,
        contentType: financialTransactionsResponse.headers['content-type'],
        response: financialTransactionsResponse.data
      });
    } catch (error) {
      attempts.push({
        name: 'Financial Transactions API',
        error: error.message,
        status: error.response?.status
      });
    }
    
    // Attempt 5: Try extracting all financial information
    try {
      const allFinancialsUrl = `https://${hireHopDomain}/api/job_financials.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
      console.log(`Attempt 5: Job financials at ${allFinancialsUrl.substring(0, allFinancialsUrl.indexOf('token'))}`);
      
      const allFinancialsResponse = await axiosInstance.get(allFinancialsUrl);
      attempts.push({
        name: 'Job Financials API',
        status: allFinancialsResponse.status,
        contentType: allFinancialsResponse.headers['content-type'],
        response: allFinancialsResponse.data
      });
    } catch (error) {
      attempts.push({
        name: 'Job Financials API',
        error: error.message,
        status: error.response?.status
      });
    }
    
    // Return all the results from our attempts
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify({
        message: 'Billing page scrape attempts',
        jobId,
        attempts
      })
    };
    
  } catch (error) {
    console.log('Error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ 
        message: 'Error scraping billing page', 
        error: error.message
      })
    };
  }
};
