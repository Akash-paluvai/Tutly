# Challenge 001 — Reference Solution

This document contains the verified reference solution for [`backend/controllers/productController.js`](./backend/controllers/productController.js).

When applied, all visible tests (`tests/product.visible.test.js`) and hidden judge tests (`__hidden__/product.hidden.test.js`) pass with 100% success.

---

## Solved `productController.js`

```javascript
// backend/controllers/productController.js
const productsData = require("../data/products");

// GET /api/products
function getProducts(req, res) {
  const products = productsData.getAll();
  return res.status(200).json(products);
}

// POST /api/products
function createProduct(req, res) {
  const { name, price, tags } = req.body;

  // Bug 2 Fix: Validate tags (must be an array and have >= 3 items)
  if (!Array.isArray(tags) || tags.length < 3) {
    return res.status(400).json({
      error: "At least 3 tags are required",
    });
  }

  // Bug 1 Fix: Save product and return 201 Created with the created product object
  const created = productsData.add({ name, price, tags });
  return res.status(201).json(created);
}

// DELETE /api/products/:id
function deleteProduct(req, res) {
  const { id } = req.params;

  // Bug 3 Fix: Check if product exists; if not found, return 404
  const product = productsData.findById(id);
  if (!product) {
    return res.status(404).json({
      error: "Product not found",
    });
  }

  // Permanently delete only the requested product and return 200
  productsData.deleteById(id);
  return res.status(200).json({
    message: "Product deleted successfully",
  });
}

module.exports = {
  getProducts,
  createProduct,
  deleteProduct,
};
```

---

## Verification Result

```
PASS tests/product.visible.test.js
  Product Management - Visible Tests
    ✓ rejects fewer than 3 tags (17 ms)
    ✓ creates a product (4 ms)
    ✓ stores tags correctly (3 ms)
    ✓ deletes a product (3 ms)

PASS __hidden__/product.hidden.test.js
  Product Management - Hidden Judge Tests
    ✓ product gets unique ID (3 ms)
    ✓ invalid product ID returns 404 (2 ms)
    ✓ deleted product cannot be retrieved (3 ms)
    ✓ malformed request is rejected (2 ms)

Test Suites: 2 passed, 2 total
Tests:       8 passed, 8 total
Snapshots:   0 total
Time:        0.33 s
```
