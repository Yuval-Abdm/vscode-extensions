<?php
require_once __DIR__ . '/lib/helpers.php';
require_once __DIR__ . '/lib/User.php';

use Shop\Unused; // expect: unused-use

$user = new User('Ada');
$user->greet();
$user->missingMethod(); // expect: undefined-method
echo $user->name;
echo $user->nope; // expect: undefined-property
echo helper(1, 2, 3); // expect: argument-count
echo unknown_function(); // expect: undefined-function
echo UNKNOWN_CONSTANT; // expect: undefined-constant
$x = (real) 1; // expect: deprecated-syntax
if (function_exists('maybe_later')) {
    maybe_later();
}
echo $undefined; // expect: undefined-variable
echo legacy(); // @php-forge-ignore argument-count
return;
echo 'never'; // expect: unreachable-code
