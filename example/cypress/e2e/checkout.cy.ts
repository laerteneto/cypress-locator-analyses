import { CheckoutPage } from '../pages/checkout.page';

describe('Checkout', () => {
  it('applies a discount coupon', () => {
    const checkout = new CheckoutPage();
    checkout.applyCoupon('BLACKFRIDAY');
    checkout.total.should('have.text', '$90.00');
  });

  it('removes an item from the cart', () => {
    const checkout = new CheckoutPage();
    checkout.items.eq(1).findByRole('button', { name: 'Remove' }).click();
    checkout.items.should('have.length', 1);
  });

  it('shows the product row', () => {
    const checkout = new CheckoutPage();
    checkout.itemRow('T-shirt').should('be.visible');
  });
});
