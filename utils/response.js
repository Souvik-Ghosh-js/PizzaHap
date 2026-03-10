const success = (res, data = {}, message = 'Success', statusCode = 200) => {
  return res.status(statusCode).json({ success: true, message, data });
};

const created = (res, data = {}, message = 'Created successfully') => {
  return res.status(201).json({ success: true, message, data });
};

const error = (res, message = 'Something went wrong', statusCode = 500, errors = null) => {
  const response = { success: false, message };
  if (errors) response.errors = errors;
  return res.status(statusCode).json(response);
};

const badRequest = (res, message = 'Bad Request', errors = null) => error(res, message, 400, errors);
const unauthorized = (res, message = 'Unauthorized') => error(res, message, 401);
const forbidden = (res, message = 'Access Forbidden') => error(res, message, 403);
const notFound = (res, message = 'Not Found') => error(res, message, 404);
const conflict = (res, message = 'Conflict') => error(res, message, 409);

const paginated = (res, data, total, page, limit, message = 'Success') => {
  return res.status(200).json({
    success: true, message, data,
    pagination: {
      total,
      page: parseInt(page),
      limit: parseInt(limit),
      totalPages: Math.ceil(total / limit),
      hasNext: page * limit < total,
      hasPrev: page > 1,
    },
  });
};

module.exports = { success, created, error, badRequest, unauthorized, forbidden, notFound, conflict, paginated };
