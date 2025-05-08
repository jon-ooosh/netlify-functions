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
    // For now, we'll return mock data
    // TODO: Replace with actual HireHop API call
    
    // This simulates different scenarios based on job ID
    let mockData;
    
    // Using the last digit of the job number to simulate different scenarios
    const lastDigit = parseInt(jobId.toString().slice(-1));
    
    if (lastDigit === 0) {
      // Scenario: Fully paid booking
      mockData = {
        jobId: jobId,
        customerName: "Test Customer",
        totalAmount: 800.00,
        paidAmount: 800.00,
        remainingAmount: 0.00,
        depositAmount: 200.00,
        depositPaid: true,
        hireDuration: 3,
        requiresExcess: true,
        excessMethod: "pre-auth"
      };
    } else if (lastDigit % 2 === 0) {
      // Scenario: Deposit paid, balance due
      mockData = {
        jobId: jobId,
        customerName: "Test Customer",
        totalAmount: 800.00,
        paidAmount: 200.00,
        remainingAmount: 600.00,
        depositAmount: 200.00,
        depositPaid: true,
        hireDuration: 3,
        requiresExcess: true,
        excessMethod: "pre-auth"
      };
    } else {
      // Scenario: Nothing paid yet
      mockData = {
        jobId: jobId,
        customerName: "Test Customer",
        totalAmount: 800.00,
        paidAmount: 0.00,
        remainingAmount: 800.00,
        depositAmount: 200.00,
        depositPaid: false,
        hireDuration: 7,
        requiresExcess: true,
        excessMethod: "payment"
      };
    }
    
    /* 
    TODO: Uncomment and replace with actual API call to HireHop
    
    // API call to HireHop
    const hireHopApiKey = process.env.HIREHOP_API_KEY;
    const hireHopApiUrl = process.env.HIREHOP_API_URL;
    
    // Get basic job info
    const jobResponse = await axios.get(`${hireHopApiUrl}/job/${jobId}`, {
      headers: { 'Authorization': `Bearer ${hireHopApiKey}` }
    });
    
    // Get hire details to determine duration
    const hiresResponse = await axios.get(`${hireHopApiUrl}/job/${jobId}/hires`, {
      headers: { 'Authorization': `Bearer ${hireHopApiKey}` }
    });
    
    // Get existing payments
    const paymentsResponse = await axios.get(`${hireHopApiUrl}/job/${jobId}/payments`, {
      headers: { 'Authorization': `Bearer ${hireHopApiKey}` }
    });
    
    const job = jobResponse.data;
    const hires = hiresResponse.data;
    const payments = paymentsResponse.data;
    
    // Calculate hire duration (in days)
    let hireDuration = 0;
    if (hires && hires.length > 0) {
      // Get the longest hire duration if multiple items
      hires.forEach(hire => {
        const startDate = new Date(hire.start_date);
        const endDate = new Date(hire.end_date);
        const duration = Math.ceil((endDate - startDate) / (1000 * 60 * 60 * 24));
        hireDuration = Math.max(hireDuration, duration);
      });
    }
    
    // Calculate total and paid amounts
    const totalAmount = parseFloat(job.total_amount);
    let paidAmount = 0;
    
    if (payments && payments.length > 0) {
      payments.forEach(payment => {
        paidAmount += parseFloat(payment.amount);
      });
    }
    
    // Calculate amounts due
    const remainingAmount = totalAmount - paidAmount;
    
    // Determine deposit amount (25% or £100, whichever is greater)
    // For bookings under £400, full payment is required
    let depositAmount = 0;
    if (totalAmount < 400) {
      depositAmount = totalAmount;
    } else {
      depositAmount = Math.max(totalAmount * 0.25, 100);
    }
    
    // Determine if deposit has been paid
    const depositPaid = paidAmount >= depositAmount;
    
    // Create response data
    const responseData = {
      jobId,
      customerName: job.customer_name,
      totalAmount,
      paidAmount,
      remainingAmount,
      depositAmount,
      depositPaid,
      hireDuration,
      requiresExcess: true, // Assuming all hires require excess
      excessMethod: hireDuration <= 4 ? 'pre-auth' : 'payment'
    };
    */
    
    return {
      statusCode: 200,
      headers,
      body: JSON.stringify(mockData)
    };
  } catch (error) {
    console.log('Error:', error);
    
    return {
      statusCode: 500,
      headers,
      body: JSON.stringify({ message: 'Error fetching job details', error: error.message })
    };
  }
};
