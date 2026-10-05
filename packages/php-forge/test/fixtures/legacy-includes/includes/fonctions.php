<?php
function format_date($d)
{
    return date('d/m/Y', strtotime($d));
}

function parse_ref($text, &$out)
{
    $out = trim($text);
}
