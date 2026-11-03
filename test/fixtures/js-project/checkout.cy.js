import checkoutPage from '@pages/checkout.page';

it('pays through an aliased JS page object', () => {
  checkoutPage.pay();
});
