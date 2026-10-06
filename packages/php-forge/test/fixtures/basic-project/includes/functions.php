<?php
define('APP_NAME', 'Demo');

/** Formate un prix en euros. */
function format_price(float $amount): string
{
    return number_format($amount, 2, ',', ' ') . ' €';
}
