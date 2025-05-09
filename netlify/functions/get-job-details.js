// Netlify Function to get job details from HireHop
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
    const hireHopBaseUrl = process.env.HIREHOP_BASE_URL || 'https://myhirehop.com/api';
    
    if (!hireHopToken) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ message: 'HireHop API token is not configured' })
      };
    }
    
    console.log(`Using HireHop API: ${hireHopBaseUrl}`);
    console.log(`Fetching job details for job ${jobId}`);
    
    // Get basic job data
    const jobResponse = await axios.get(`${hireHopBaseUrl}/job_data.php`, {
      params: {
        job: jobId,
        token: hireHopToken
      }
    });
    
    console.log('Successfully fetched job data');
    
    // Check if job exists and if there's an error
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
    
    // Get payments
    // Note: We need to use the correct endpoint for payments based on HireHop's API
    const paymentsResponse = await axios.get(`${hireHopBaseUrl}/job_payments.php`, {
      params: {
        job: jobId,
        token: hireHopToken
      }
    });
    
    console.log('Successfully fetched payments');
    const payments = paymentsResponse.data || [];
    
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
    // First check if VAT rate is specified in the job
    let vatRate = 0.20; // Default VAT rate of 20%
    
    // Check if standard tax rates are available
    if (job.standard_tax_rates && Array.isArray(job.standard_tax_rates) && job.standard_tax_rates.length > 0) {
      // Use the first tax rate (usually the standard VAT rate)
      const taxRate = job.standard_tax_rates[0][0]; // Get first tax rate
      if (taxRate && taxRate.RATE) {
        vatRate = parseFloat(taxRate.RATE) / 100; // Convert percentage to decimal
      }
    }
    
    // Check if job is VAT-exempt - this may need to be adjusted based on HireHop's actual data structure
    const isVatExempt = job.USE_SALES_TAX === "0" || parseFloat(job.DEFAULT_SALES_TAX) === 0;
    
    // If VAT exempt, set rate to 0
    if (isVatExempt) {
      vatRate = 0;
    }
    
    // Calculate amounts
    // Get the total amount from the job data - we need to find the correct field
    const netTotalAmount = parseFloat(job.PRICE || job.TOTAL || 0);
    
    // Calculate VAT and gross amount
    const vatAmount = netTotalAmount * vatRate;
    const grossTotalAmount = netTotalAmount + vatAmount;
    
    // Calculate paid amounts
    let netPaidAmount = 0;
    
    if (Array.isArray(payments)) {
      payments.forEach(payment => {
        // Only count actual payments, not credits or other types
        if (payment.TYPE === "payment" || payment.TYPE === "card" || payment.TYPE === "bank" || !payment.TYPE) {
          netPaidAmount += parseFloat(payment.AMOUNT || 0);
        }
      });
    }
    
    // Assume payments in HireHop are also net
    const grossPaidAmount = netPaidAmount * (1 + vatRate);
    
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
    
    // Determine if deposit has been paid
    const depositPaid = grossPaidAmount >= grossDepositAmount;
    
    // Format amounts to 2 decimal places
    const formatAmount = (amount) => parseFloat(parseFloat(amount).toFixed(2));
    
    // Get customer email if available
    const customerEmail = job.EMAIL || null;
    
    // Create response data
    const responseData = {
      jobId,
      customerName: job.NAME || "Customer",
      customerEmail, 
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
    
    // Determine the appropriate error message and status code
    let statusCode = 500;
    let message = 'Error fetching job details';
    let errorDetails = error.message;
    
    if (error.response) {
      // The request was made and the server responded with a status code
      statusCode = error.response.status;
      message = `HireHop API Error: ${error.response.statusText}`;
      errorDetails = error.response.data || error.message;
    } else if (error.request) {
      // The request was made but no response was received
      message = 'No response received from HireHop API';
      errorDetails = 'Check API URL and token';
    }
    
    return {
      statusCode,
      headers,
      body: JSON.stringify({ 
        message, 
        error: errorDetails,
        url: process.env.HIREHOP_BASE_URL || 'API URL not set'
      })
    };
  }
};
