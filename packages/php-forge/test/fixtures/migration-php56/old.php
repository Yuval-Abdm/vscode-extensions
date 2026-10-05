<?php
$link = mysql_connect('localhost', 'root', ''); // expect: migration-removed-api
$res = mysql_query('SELECT 1'); // expect: migration-removed-api
while (list($k, $v) = each($tab)) { // expect: migration-removed-api
    echo $k;
}
if (ereg('^[0-9]+$', $code)) { // expect: migration-removed-api
    $x = (real)$code; // expect: migration-syntax
}
$f = create_function('$a', 'return $a * 2;'); // expect: migration-removed-api
if ($_GET['n'] == 0) { // expect: migration-behavior
    echo 'zéro';
}
$s = "abc";
echo $s{0}; // expect: migration-syntax

class Panier
{
    function Panier() // expect: migration-syntax
    {
        $this->total = 0;
    }
}
