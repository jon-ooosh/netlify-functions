// Netlify Function to get job details from HireHop - Final Version
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
    
    console.log(`Fetching job details for job ${jobId}`);
    
    // Get basic job data
    const jobDataUrl = `https://${hireHopDomain}/api/job_data.php?job=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
    const jobResponse = await axios.get(jobDataUrl);
    
    if (!jobResponse.data || jobResponse.data.error) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ 
          message: 'Job not found or error retrieving job', 
          error: jobResponse.data?.error || 'No job data returned'
        })
      };
    }
    
    const job = jobResponse.data;
    
    // Get financial data
    const financialUrl = `https://${hireHopDomain}/php_functions/job_margins.php?job_id=${jobId}&token=${encodeURIComponent(hireHopToken)}`;
    const financialResponse = await axios.get(financialUrl);
    const financialData = financialResponse.data || {};
    
    // Calculate hire duration from the job data
    let hireDuration = 0;
    
    if (job.DURATION_DAYS) {
      // Use the duration days from the job data if available
      hireDuration = parseInt(job.DURATION_DAYS);
    } else if (job.OUT_DATE && job.RETURN_DATE) {
      // Calculate duration from dates
      const startDate = new Date(job.OUT_DATE);
      const endDate = new Date(job.RETURN_DATE);
      hireDuration = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1; // +1 to include both days
    }
    
    // Get VAT information
    let vatRate = 0.20; // Default VAT rate of 20%
    
    // Check if standard tax rates are available
    if (job.standard_tax_rates && Array.isArray(job.standard_tax_rates) && job.standard_tax_rates.length > 0) {
      // Use the first tax rate (usually the standard VAT rate)
      const taxRate = job.standard_tax_rates[0][0]; // Get first tax rate
      if (taxRate && taxRate.RATE) {
        vatRate = parseFloat(taxRate.RATE) / 100; // Convert percentage to decimal
      }
    }
    
    // Check if job is VAT-exempt
    const isVatExempt = job.USE_SALES_TAX === "0" || parseFloat(job.DEFAULT_SALES_TAX) === 0;
    
    // If VAT exempt, set rate to 0
    if (isVatExempt) {
      vatRate = 0;
    }
    
    // Get the total amount from financial data
    let netTotalAmount = 0;
    if (financialData && typeof financialData === 'object') {
      if (financialData.total_revenue !== undefined) {
        netTotalAmount = parseFloat(financialData.total_revenue || 0);
      }
    }
    
    // If we couldn't get it from financial data, try job data
    if (netTotalAmount === 0) {
      if (job.PRICE !== undefined) {
        netTotalAmount = parseFloat(job.PRICE || 0);
      } else if (job.TOTAL_PRICE !== undefined) {
        netTotalAmount = parseFloat(job.TOTAL_PRICE || 0);
      } else if (job.TOTAL !== undefined) {
        netTotalAmount = parseFloat(job.TOTAL || 0);
      }
    }
    
    // Calculate VAT and gross amount
    const vatAmount = netTotalAmount * vatRate;
    const grossTotalAmount = netTotalAmount + vatAmount;
    
    // Without direct access to payment data, we'll assume nothing has been paid yet
    // This will be a conservative approach - customer can pay deposit/full amount
    const netPaidAmount = 0;
    const grossPaidAmount = 0;
    
    // Calculate remaining amount (gross)
    const grossRemainingAmount = grossTotalAmount - grossPaidAmount;
    
    // Determine deposit amount (25% or £100 of gross total, whichever is greater)
    // For bookings under £400 (gross), full payment is required
    let grossDepositAmount = 0;
    if (grossTotalAmount < 400) {
      grossDepositAmount = grossTotalAmount;
    } else {
      grossDepositAmount = Math.max(grossTotalAmount * 0.25, 100);
    }
    
    // Since we're assuming nothing has been paid, deposit is not paid
    const depositPaid = false;
    
    // Format amounts to 2 decimal places
    const formatAmount = (amount) => parseFloat(parseFloat(amount).toFixed(2));
    
    // Create response data
    const responseData = {
      jobId,
      customerName: job.NAME || "Customer",
      customerEmail: job.EMAIL || null, 
      totalAmount: formatAmount(grossTotalAmount),
      paidAmount: formatAmount(grossPaidAmount),
      remainingAmount: formatAmount(grossRemainingAmount),
      depositAmount: formatAmount(grossDepositAmount),
      depositPaid,
      hireDuration,
      requiresExcess: true, // Assuming all hires require excess
      excessMethod: hireDuration <= 4 ? 'pre-auth' : 'payment',
      vatInfo: {
        rate: vatRate,
        isExempt: isVatExempt,
        netTotal: formatAmount(netTotalAmount),
        vatAmount: formatAmount(vatAmount),
        grossTotal: formatAmount(grossTotalAmount)
      }
    };
    
    console.log('Processed job data successfully');
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(responseData)
    };
  } catch (error) {
    console.log('Error:', error);
    
    let statusCode = 500;
    let message = 'Error fetching job details';
    let errorDetails = error.message;
    
    if (error.response) {
      statusCode = error.response.status;
      message = `HireHop API Error: ${error.response.statusText}`;
      errorDetails = error.response.data || error.message;
    } else if (error.request) {
      message = 'No response received from HireHop API';
      errorDetails = 'Check API URL and token';
    }
    
    return {
      statusCode,
      headers,
      body: JSON.stringify({ 
        message, 
        error: errorDetails,
        url: `https://${hireHopDomain}/api`
      })
    };
  }
};
