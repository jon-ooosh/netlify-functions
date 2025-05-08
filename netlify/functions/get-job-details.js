// Netlify Function to get job details from HireHop
const axios = require('axios');

exports.handler = async function(event, context) {
  // Set CORS headers
  const headers = {
    'Access-Control-Allow-Origin': '*', // In production, set this to your specific domain
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
    const hireHopApiKey = process.env.HIREHOP_API_KEY;
    const hireHopApiUrl = process.env.HIREHOP_API_URL || 'https://api.hirehop.com/api/v1';
    
    if (!hireHopApiKey) {
      return {
        statusCode: 500,
        headers,
        body: JSON.stringify({ message: 'HireHop API key is not configured' })
      };
    }
    
    // Configure headers for HireHop API requests
    const apiHeaders = {
      'Authorization': `Bearer ${hireHopApiKey}`,
      'Content-Type': 'application/json'
    };
    
    // Make API calls to HireHop
    console.log(`Fetching job details for job ${jobId} from HireHop`);
    
    // Get basic job info
    const jobResponse = await axios.get(`${hireHopApiUrl}/job/${jobId}`, {
      headers: apiHeaders
    });
    
    // Get hire details to determine duration
    const hiresResponse = await axios.get(`${hireHopApiUrl}/job/${jobId}/hires`, {
      headers: apiHeaders
    });
    
    // Get existing payments
    const paymentsResponse = await axios.get(`${hireHopApiUrl}/job/${jobId}/payments`, {
      headers: apiHeaders
    });
    
    const job = jobResponse.data;
    const hires = hiresResponse.data;
    const payments = paymentsResponse.data || [];
    
    console.log('Job data fetched successfully');
    
    // Check if job exists
    if (!job || Object.keys(job).length === 0) {
      return {
        statusCode: 404,
        headers,
        body: JSON.stringify({ message: 'Job not found' })
      };
    }
    
    // Calculate hire duration (in days)
    let hireDuration = 0;
    if (hires && hires.length > 0) {
      // Get the longest hire duration if multiple items
      hires.forEach(hire => {
        const startDate = new Date(hire.start_date);
        const endDate = new Date(hire.end_date);
        const duration = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24)) + 1; // +1 to include both start and end days
        hireDuration = Math.max(hireDuration, duration);
      });
    }
    
    // Get VAT information
    // First check if VAT rate is specified in the job
    let vatRate = 0.20; // Default VAT rate of 20%
    
    if (job.vat_rate) {
      vatRate = parseFloat(job.vat_rate) / 100; // Convert percentage to decimal
    }
    
    // Check if job is VAT-exempt
    const isVatExempt = job.vat_exempt === true || job.vat_exempt === "true" || job.vat_exempt === 1;
    
    // If VAT exempt, set rate to 0
    if (isVatExempt) {
      vatRate = 0;
    }
    
    // Calculate amounts
    // Note: HireHop amounts are typically net (without VAT)
    const netTotalAmount = parseFloat(job.total_amount) || 0;
    const vatAmount = netTotalAmount * vatRate;
    const grossTotalAmount = netTotalAmount + vatAmount;
    
    // Calculate paid amounts
    let netPaidAmount = 0;
    
    if (payments && payments.length > 0) {
      payments.forEach(payment => {
        netPaidAmount += parseFloat(payment.amount) || 0;
      });
    }
    
    // Assume payments in HireHop are also net
    const grossPaidAmount = netPaidAmount * (1 + vatRate);
    
    // Calculate remaining amount (gross)
    const grossRemainingAmount = grossTotalAmount - grossPaidAmount;
    const netRemainingAmount = netTotalAmount - netPaidAmount;
    
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
    const formatAmount = (amount) => parseFloat(amount.toFixed(2));
    
    // Create response data
    const responseData = {
      jobId,
      customerName: job.customer_name,
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
    
    console.log('Processed job data:', responseData);
    
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
    
    if (error.response) {
      // The request was made and the server responded with a status code
      // that falls out of the range of 2xx
      statusCode = error.response.status;
      message = `HireHop API Error: ${error.response.statusText}`;
      console.log('Error response data:', error.response.data);
    } else if (error.request) {
      // The request was made but no response was received
      message = 'No response received from HireHop API';
    }
    
    return {
      statusCode,
      headers,
      body: JSON.stringify({ message, error: error.message })
    };
  }
};
